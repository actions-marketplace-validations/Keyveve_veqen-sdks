"""LiteLLM CustomLogger. Requires the optional ``veqen[litellm]`` extra."""

from __future__ import annotations

import logging

from litellm.integrations.custom_logger import CustomLogger

from veqen.client import client, current_tags
from veqen.integrations._litellm_payload import _object, standard_call
from veqen.integrations.litellm import callback, provider_key_hint
from veqen.pricing import Usage

log = logging.getLogger("veqen")


class VeqenLogger(CustomLogger):
    """Request-level callbacks only: do not register alongside the function callback or HTTP logger.

    Model content stays in the process. Only allowlisted cost metadata enters Veqen's queue.
    This logger observes completed requests; use the Veqen wrapper for pre-call budget enforcement.
    """

    def _record(self, kwargs, response_obj, start_time, end_time):
        try:
            payload = kwargs.get("standard_logging_object")
            if not isinstance(payload, dict):
                callback(kwargs, response_obj, start_time, end_time)
                return
            event = standard_call(payload)
            request_tags = _object(_object(_object(kwargs.get("litellm_params")).get("metadata")).get("veqen"))
            request_tags = {name: str(value) for name, value in request_tags.items()
                            if name in ("customer", "feature", "user", "project", "environment")
                            and isinstance(value, (str, int, float, bool))} if isinstance(request_tags, dict) else {}
            usage = Usage(**{name: event[name] for name in (
                "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cache_write_1h_tokens",
            )})
            client.record(
                event["provider"], event["model"], usage,
                tags={**current_tags(), **request_tags, **{name: event[name] for name in (
                    "customer", "feature", "user", "project", "environment",
                ) if name in event}},
                cost_usd=event["cost_usd"], latency_ms=event["latency_ms"],
                service_tier=event["service_tier"], status=event["status"],
                key_hint=provider_key_hint(_object(kwargs.get("litellm_params"))),
            )
        except (KeyError, TypeError, ValueError, OverflowError, OSError):
            log.warning("Veqen skipped invalid LiteLLM cost metadata")

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._record(kwargs, response_obj, start_time, end_time)

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._record(kwargs, response_obj, start_time, end_time)

    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        if isinstance(kwargs.get("standard_logging_object"), dict):
            self._record(kwargs, response_obj, start_time, end_time)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self.log_failure_event(kwargs, response_obj, start_time, end_time)
