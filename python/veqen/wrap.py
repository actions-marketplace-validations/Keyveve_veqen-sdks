"""``veqen.wrap(client)``: exact cost on every OpenAI, Anthropic and Google GenAI call, including OpenAI
clients pointed at other hosts (Together, Fireworks, Groq, DeepInfra, xAI and the rest) and the image,
speech, transcription and embedding endpoints.

The wrapper is a thin proxy. It only intercepts the methods that produce model output, reads the
usage the provider already returns, and never touches prompts or responses."""

from __future__ import annotations

import functools
import inspect
import logging
import time
from typing import Any

from veqen.client import client as _client
from veqen.client import current_tags, key_hint
from veqen.pricing import Usage, price_book

log = logging.getLogger("veqen")

_METHODS = {
    "openai": {
        ("chat", "completions", "create"),
        ("chat", "completions", "stream"),
        ("responses", "create"),
        ("responses", "stream"),
        ("embeddings", "create"),
        ("images", "generate"),
        ("images", "edit"),
        ("audio", "speech", "create"),
        ("audio", "transcriptions", "create"),
        ("audio", "translations", "create"),
    },
    "anthropic": {("messages", "create"), ("messages", "stream"), ("beta", "messages", "create")},
    "google": {
        ("models", "generate_content"),
        ("models", "generate_content_stream"),
        ("aio", "models", "generate_content"),
        ("aio", "models", "generate_content_stream"),
    },
}
_MEDIA = {("images", "generate"), ("images", "edit"), ("audio", "speech", "create"),
          ("audio", "transcriptions", "create"), ("audio", "translations", "create")}
_FINAL = ("get_final_completion", "get_final_response", "get_final_message")


def _n(value: Any) -> int:
    return int(value or 0)


def _usage_openai(obj: Any) -> tuple[Any, Usage, str | None] | None:
    obj = getattr(obj, "response", None) or obj  # Responses API stream events wrap the response
    u = getattr(obj, "usage", None)
    if u is None:
        return None
    if hasattr(u, "prompt_tokens"):
        cached = _n(getattr(getattr(u, "prompt_tokens_details", None), "cached_tokens", 0))
        output = _n(getattr(u, "completion_tokens", 0))  # embeddings report input only
        usage = Usage(_n(u.prompt_tokens) - cached, output, cached)
    else:
        cached = _n(getattr(getattr(u, "input_tokens_details", None), "cached_tokens", 0))
        usage = Usage(_n(u.input_tokens) - cached, _n(u.output_tokens), cached)
    return getattr(obj, "model", None), usage, getattr(obj, "service_tier", None)


def _usage_anthropic(obj: Any) -> tuple[Any, Usage, str | None] | None:
    u = getattr(obj, "usage", None)
    if u is None:
        return None
    one_hour = _n(getattr(getattr(u, "cache_creation", None), "ephemeral_1h_input_tokens", 0))
    usage = Usage(
        _n(getattr(u, "input_tokens", 0)),
        _n(getattr(u, "output_tokens", 0)),
        _n(getattr(u, "cache_read_input_tokens", 0)),
        _n(getattr(u, "cache_creation_input_tokens", 0)) - one_hour,
        one_hour,
    )
    return getattr(obj, "model", None), usage, getattr(u, "service_tier", None)


def _usage_google(obj: Any) -> tuple[Any, Usage, str | None] | None:
    m = getattr(obj, "usage_metadata", None)
    if m is None:
        return None
    cached = _n(getattr(m, "cached_content_token_count", 0))
    output = _n(getattr(m, "candidates_token_count", 0)) + _n(getattr(m, "thoughts_token_count", 0))
    return getattr(obj, "model_version", None), Usage(_n(m.prompt_token_count) - cached, output, cached), None


def _usage_openai_media(path: tuple, obj: Any, kwargs: dict) -> tuple[Any, Usage, None, str | None] | None:
    """Images by count (or their exact tokens when reported), speech by characters, transcription by
    seconds or tokens. The model, size and quality come from the request."""
    model, u = kwargs.get("model"), getattr(obj, "usage", None)
    if path[0] == "images":
        count = len(getattr(obj, "data", None) or []) or _n(kwargs.get("n") or 1)
        variant = "/".join(str(x) for x in (kwargs.get("quality"), kwargs.get("size")) if x and x != "auto") or None
        if u is not None and getattr(u, "input_tokens", None) is not None:
            return model, Usage(_n(u.input_tokens), _n(u.output_tokens), units=count), None, variant
        return model, Usage(units=count), None, variant
    if path[1] == "speech":
        return model, Usage(units=len(str(kwargs.get("input") or ""))), None, None
    if u is not None and getattr(u, "type", "") == "tokens":
        audio = _n(getattr(getattr(u, "input_token_details", None), "audio_tokens", 0))
        return model, Usage(_n(u.input_tokens) - audio, _n(u.output_tokens), audio_input_tokens=audio), None, None
    seconds = getattr(u, "seconds", None) or getattr(obj, "duration", None)
    return (model, Usage(units=float(seconds)), None, None) if seconds else None


_EXTRACT = {"openai": _usage_openai, "anthropic": _usage_anthropic, "google": _usage_google}


class _Accumulator:
    """Collects usage across stream chunks; emits once when the stream ends."""

    def __init__(self, provider: str, done) -> None:
        self.provider, self.done, self.found, self.emitted = provider, done, None, False
        self.anthropic_start: Usage | None = None

    def feed(self, item: Any) -> None:
        if self.provider == "anthropic":
            kind = getattr(item, "type", "")
            if kind == "message_start":
                self.found = _usage_anthropic(item.message)
                self.anthropic_start = self.found[1] if self.found else None
            elif kind == "message_delta" and self.found and getattr(item, "usage", None):
                start = self.anthropic_start
                out = _n(getattr(item.usage, "output_tokens", 0))
                self.found = (self.found[0], Usage(start.input_tokens, out, start.cache_read_tokens,
                                                   start.cache_write_tokens, start.cache_write_1h_tokens),
                              self.found[2])
            return
        extracted = _EXTRACT[self.provider](item)
        if extracted is not None and (extracted[1].input_tokens or extracted[1].output_tokens):
            self.found = extracted

    def finish(self) -> None:
        if not self.emitted:
            self.emitted = True
            self.done(self.found)


class _Stream:
    """Iterates a provider stream (sync or async) and records usage when it ends or is closed."""

    def __init__(self, inner: Any, acc: _Accumulator) -> None:
        self._inner, self._acc = inner, acc

    def __iter__(self):
        try:
            for item in self._inner:
                self._acc.feed(item)
                yield item
        finally:
            self._acc.finish()

    async def __aiter__(self):
        try:
            async for item in self._inner:
                self._acc.feed(item)
                yield item
        finally:
            self._acc.finish()

    def __enter__(self):
        self._inner.__enter__()
        return self

    def __exit__(self, *exc):
        self._acc.finish()
        return self._inner.__exit__(*exc)

    async def __aenter__(self):
        await self._inner.__aenter__()
        return self

    async def __aexit__(self, *exc):
        self._acc.finish()
        return await self._inner.__aexit__(*exc)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


class _Managed:
    """Wraps SDK stream helpers (``messages.stream()``, ``responses.stream()``) and records the final
    message's usage when the ``with`` block exits."""

    def __init__(self, manager: Any, done) -> None:
        self._manager, self._done, self._stream = manager, done, None

    def __enter__(self):
        self._stream = self._manager.__enter__()
        return self._stream

    def __exit__(self, *exc):
        if exc[0] is None:
            final = next((getattr(self._stream, n) for n in _FINAL if hasattr(self._stream, n)), None)
            self._done(final() if final else None)
        return self._manager.__exit__(*exc)

    async def __aenter__(self):
        self._stream = await self._manager.__aenter__()
        return self._stream

    async def __aexit__(self, *exc):
        if exc[0] is None:
            final = next((getattr(self._stream, n) for n in _FINAL if hasattr(self._stream, n)), None)
            self._done(await final() if final else None)
        return await self._manager.__aexit__(*exc)


class _Proxy:
    def __init__(self, target: Any, provider: str, path: tuple, defaults: dict, residency: str | None,
                 host: str | None = None, hint: str | None = None) -> None:
        self._target, self._provider, self._path = target, provider, path
        self._defaults, self._residency = defaults, residency
        self._host = host  # the provider behind the client's base URL, when it isn't the SDK's own
        self._hint = hint  # the client's key, its last four characters

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._target, name)
        path = self._path + (name,)
        methods = _METHODS[self._provider]
        if path in methods and callable(attr):
            return self._instrument(attr, path)
        if any(m[: len(path)] == path for m in methods):
            return _Proxy(attr, self._provider, path, self._defaults, self._residency, self._host, self._hint)
        return attr

    def _instrument(self, fn, path: tuple):
        provider = self._provider

        def prepare(kwargs: dict) -> tuple[dict, dict, float]:
            tags = {**self._defaults, **current_tags()}
            _client.check(tags)
            if provider == "openai" and path[0] == "chat" and kwargs.get("stream"):
                kwargs = {**kwargs, "stream_options": {**(kwargs.get("stream_options") or {}), "include_usage": True}}
            return kwargs, tags, time.monotonic()

        def emitter(kwargs: dict, tags: dict, started: float):
            def done(found) -> None:
                try:
                    if found is not None and not isinstance(found, tuple):
                        found = _EXTRACT[provider](found)
                    if found is None:
                        return  # the provider reported no usage, so there is nothing to price
                    reported, usage, tier, *rest = found
                    source = self._host or provider
                    requested = kwargs.get("model")
                    priced = reported and (price_book().lookup(str(reported), source) or not requested)
                    model = reported if priced else requested
                    if model:
                        _client.record(
                            source, str(model), usage, tags=tags, service_tier=tier, residency=self._residency,
                            variant=rest[0] if rest else None, latency_ms=int((time.monotonic() - started) * 1000),
                            key_hint=self._hint,
                        )
                except Exception:  # noqa: BLE001 - the call already succeeded; recording must never break it
                    log.exception("Veqen couldn't record a %s call", provider)

            return done

        def finish(result: Any, kwargs: dict, done) -> Any:
            if path[-1] == "stream":  # SDK stream helpers return context managers
                return _Managed(result, done)
            if kwargs.get("stream") or path[-1].endswith("_stream"):
                return _Stream(result, _Accumulator(provider, done))
            done(_usage_openai_media(path, result, kwargs) if path in _MEDIA else _EXTRACT[provider](result))
            return result

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def acall(*args, **kwargs):
                kwargs, tags, started = prepare(kwargs)
                return finish(await fn(*args, **kwargs), kwargs, emitter(kwargs, tags, started))

            return acall

        @functools.wraps(fn)
        def call(*args, **kwargs):
            kwargs, tags, started = prepare(kwargs)
            return finish(fn(*args, **kwargs), kwargs, emitter(kwargs, tags, started))

        return call


# Anthropic's clients for the clouds bill through the cloud, whose regional hosts no URL map can list
_CLOUDS = {"AnthropicBedrock": "bedrock", "AsyncAnthropicBedrock": "bedrock", "AnthropicVertex": "google",
           "AsyncAnthropicVertex": "google"}


def _detect(client: Any) -> str:
    module = type(client).__module__.split(".")[0]
    if module in ("openai", "anthropic"):
        return module
    if module == "google":
        return "google"
    raise TypeError(f"veqen.wrap() supports OpenAI, Anthropic and Google GenAI clients, not {type(client)!r}")


def wrap(client: Any, *, residency: str | None = None, provider: str | None = None, **default_tags: str) -> Any:
    """Return ``client`` with every model call priced and attributed. Pass default tags such as
    ``feature="support-bot"`` or ``project="evals"``; per-request tags come from ``with veqen.tags(...)``.
    OpenAI-compatible clients pointed at another host are priced as that host's models. Pass ``provider``
    for a host Veqen doesn't recognize, such as your own vLLM server with a custom price."""
    family = _detect(client)
    url = getattr(client, "base_url", None)
    host = provider or _CLOUDS.get(type(client).__name__) or price_book().provider_for_url(url)
    key = getattr(client, "api_key", None) or getattr(client, "aws_access_key", None) or getattr(
        getattr(client, "_api_client", None), "api_key", None)  # OpenAI, Anthropic, Anthropic on Bedrock, Google GenAI
    return _Proxy(client, family, (), {k: str(v) for k, v in default_tags.items()}, residency,
                  host if host and host != family else None, key_hint(key))
