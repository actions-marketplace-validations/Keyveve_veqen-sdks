"""LiteLLM success callback (works for the SDK and the proxy's custom callbacks). Covers every provider and
model type LiteLLM supports: chat, embeddings, images (counted per image) and transcription (per second).

    import litellm
    from veqen.integrations.litellm import callback
    litellm.success_callback = [callback]

Per-request tags come from ``metadata={"veqen": {"customer": "acme"}}`` or ``veqen.tags(...)``.
"""

from __future__ import annotations

import os
from typing import Any

from veqen.client import client, current_tags, key_hint
from veqen.pricing import Usage
from veqen.wrap import _usage_openai


def provider_key_hint(params: dict) -> str | None:
    """The hint of the provider key LiteLLM used: the one passed in, else the provider's usual environment variable
    (LiteLLM reads OPENAI_API_KEY, ANTHROPIC_API_KEY and so on when none is passed). A reference such as
    "os.environ/OPENAI_API_KEY" is never mistaken for the key."""
    key = params.get("api_key")
    if params.get("api_base") and not isinstance(key, str):
        return None  # a proxy or another host: its key isn't the provider's usual variable
    if not isinstance(key, str) or key.startswith("os.environ/"):
        key = os.environ.get(f"{str(params.get('custom_llm_provider') or '').upper()}_API_KEY")
    return key_hint(key)


def callback(kwargs: dict, response: Any, start_time: Any = None, end_time: Any = None) -> None:
    params = kwargs.get("litellm_params") or {}
    options = kwargs.get("optional_params") or {}
    extracted = _usage_openai(response)
    if extracted is None:  # images and transcriptions carry no token usage
        data = getattr(response, "data", None)
        units = len(data) if isinstance(data, list) else float(getattr(response, "duration", None) or 0)
        extracted = (None, Usage(units=units), None)
    model, usage, tier = extracted
    variant = "/".join(str(x) for x in (options.get("quality"), options.get("size")) if x and x != "auto") or None
    request_tags = ((params.get("metadata") or {}).get("veqen")) or {}
    latency = int((end_time - start_time).total_seconds() * 1000) if start_time and end_time else None
    client.record(
        params.get("custom_llm_provider"),
        str(kwargs.get("model") or model),
        usage,
        tags={**current_tags(), **{k: str(v) for k, v in request_tags.items()}},
        service_tier=tier,
        variant=variant,
        latency_ms=latency,
        cost_usd=kwargs.get("response_cost"),  # kept only for models Veqen's price book doesn't know
        key_hint=provider_key_hint(params),
    )
