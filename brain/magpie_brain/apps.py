"""A team's connected apps for one turn. The agent sends each app's MCP server and a fresh key with the request.

- Stripe holds customer data, so its lookups are coded in stripe.py and always use the verified customer's email.
- Linear holds the team's own issues, so its read-only tools (those the server marks readOnlyHint) are offered to the
  model as they are, under a "linear__" prefix. Tools that change anything are never offered.
- HubSpot and Shopify hold customer data too; their identity-locked lookups come once a team has connected them and
  their tools can be read.
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Literal

from fastmcp.client import Client
from fastmcp.client.transports import StreamableHttpTransport
from pydantic import BaseModel, Field

from .stripe import GatewayStripe, StripeBackend

TOOLS_CACHE_SECONDS = 600
MAX_TOOLS_PER_APP = 15
MAX_RESULT_CHARS = 4000

_tool_cache: dict[tuple[str, str], tuple[float, list[dict[str, Any]]]] = {}


class Connection(BaseModel):
    provider: Literal["stripe", "linear", "hubspot", "shopify"]
    url: str = Field(min_length=1)
    token: str = Field(min_length=1)


def stripe_for(connections: list[Connection], default: StripeBackend | None) -> StripeBackend | None:
    """The team's own Stripe when it's connected; otherwise the brain's default (the trial's fixture, or none)."""
    for connection in connections:
        if connection.provider == "stripe":
            return GatewayStripe(connection.url, connection.token)
    return default


def _text_of(result: Any) -> str:
    if result.structured_content:
        return json.dumps(result.structured_content)
    return "\n".join(getattr(block, "text", "") for block in result.content if getattr(block, "text", ""))


class ReadOnlyTools:
    """An app's read-only MCP tools, offered to the model under the app's prefix."""

    def __init__(self, connection: Connection):
        self.connection = connection
        self.prefix = f"{connection.provider}__"

    def _transport(self) -> StreamableHttpTransport:
        return StreamableHttpTransport(self.connection.url, headers={"authorization": f"Bearer {self.connection.token}"})

    async def definitions(self) -> list[dict[str, Any]]:
        key = (self.connection.url, hashlib.sha256(self.connection.token.encode()).hexdigest())
        cached = _tool_cache.get(key)
        if cached and cached[0] > time.monotonic():
            return cached[1]
        async with Client(self._transport()) as client:
            listed = await client.list_tools()
        definitions = []
        for tool in listed:
            annotations = getattr(tool, "annotations", None)
            if not (annotations and getattr(annotations, "read_only_hint", False)):
                continue
            definitions.append(
                {
                    "name": f"{self.prefix}{tool.name}"[:64],
                    "description": f"{self.connection.provider.title()}, read only: {tool.description or tool.name}"[:1000],
                    "input_schema": tool.input_schema or {"type": "object", "properties": {}},
                }
            )
            if len(definitions) >= MAX_TOOLS_PER_APP:
                break
        _tool_cache[key] = (time.monotonic() + TOOLS_CACHE_SECONDS, definitions)
        return definitions

    def owns(self, name: str) -> bool:
        return name.startswith(self.prefix)

    async def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        allowed = {definition["name"] for definition in await self.definitions()}
        if name not in allowed:
            return {"error": "not_allowed", "say": "That tool isn't available."}
        async with Client(self._transport()) as client:
            result = await client.call_tool(name.removeprefix(self.prefix), arguments, raise_on_error=False)
        text = _text_of(result)
        if getattr(result, "is_error", False):
            return {"error": "tool_failed", "detail": text[:300]}
        return {"result": text[:MAX_RESULT_CHARS]}


def team_data_tools(connections: list[Connection]) -> list[ReadOnlyTools]:
    """Apps whose data is the team's own (not one customer's), so their read-only tools can be offered as they are."""
    return [ReadOnlyTools(connection) for connection in connections if connection.provider == "linear"]
