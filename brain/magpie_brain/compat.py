"""Lets Parlant 4.0.3 run on the current Anthropic SDK.

Parlant builds its Anthropic clients with an `httpx.Timeout`; the SDK moved to `httpx2` in 1.0 and rejects it.
Older SDKs accept the timeout but mis-assemble Sonnet 5.5's streamed thinking, so the replayed thinking block
fails Anthropic's signature check after every tool call. This converts the timeout on the way in.
Import it before Parlant.
"""

import anthropic
import httpx
import httpx2


def _to_httpx2(value: object) -> object:
    if isinstance(value, httpx.Timeout):
        return httpx2.Timeout(connect=value.connect, read=value.read, write=value.write, pool=value.pool)
    return value


def _accept_httpx_timeouts(client_class: type) -> None:
    original = client_class.__init__

    def __init__(self, *args, **kwargs):  # noqa: N807 - wraps the SDK's constructor
        if "timeout" in kwargs:
            kwargs["timeout"] = _to_httpx2(kwargs["timeout"])
        original(self, *args, **kwargs)

    client_class.__init__ = __init__


for _client in (anthropic.Anthropic, anthropic.AsyncAnthropic):
    _accept_httpx_timeouts(_client)


# Parlant rebuilds parts of the prompt between the steps of a turn, so a thinking block from an earlier step no
# longer matches the conversation it was bound to, and Anthropic refuses the request ("The block is bound to a
# different conversation"). Anthropic's own setting drops such a block instead of failing the call.
THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01"


def _drop_mismatched_thinking(kwargs: dict) -> dict:
    thinking = kwargs.get("thinking")
    if not isinstance(thinking, dict) or thinking.get("type") == "disabled":
        return kwargs
    bound = {**thinking, "block_binding": {"prefix_mismatch_behavior": "drop_block"}}
    kwargs = dict(kwargs)
    kwargs.pop("thinking")
    kwargs["extra_body"] = {**(kwargs.get("extra_body") or {}), "thinking": bound}
    headers = dict(kwargs.get("extra_headers") or {})
    betas = [beta for beta in str(headers.get("anthropic-beta", "")).split(",") if beta]
    headers["anthropic-beta"] = ",".join([*betas, THINKING_BINDING_BETA])
    kwargs["extra_headers"] = headers
    return kwargs


def _bind_thinking(messages_class: type) -> None:
    for name in ("create", "stream"):
        original = getattr(messages_class, name)

        def call(self, *args, _original=original, **kwargs):
            return _original(self, *args, **_drop_mismatched_thinking(kwargs))

        setattr(messages_class, name, call)


from anthropic.resources.messages import AsyncMessages, Messages  # noqa: E402

for _messages in (Messages, AsyncMessages):
    _bind_thinking(_messages)
