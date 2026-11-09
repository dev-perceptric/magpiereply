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
