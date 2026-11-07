"""Stripe through the team's MCP gateway server, with the official MCP Python SDK.

Parlant 4.0 has no MCP client of its own, so the brain's tools call the gateway here
(docs/phase-0.md, Day 9: the fallback, a small Python tool). Every gateway call is recorded,
so the trial's runner sees exactly which Stripe tools ran.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


@dataclass
class GatewayCall:
    name: str
    arguments: dict[str, Any]
    ok: bool
    result: str


@dataclass
class Payment:
    id: str
    amount_cents: int
    date: str
    description: str
    metadata: dict[str, str] = field(default_factory=dict)
    status: str = "unknown"


# Stripe's tools by what they do, like "list-customers". The gateway puts its own name in front
# ("stripe-list-customers") and Stripe may use underscores, so tools are found by the ending.
def tool_pattern(kind: str) -> str:
    return kind.replace("-", "[_-]") + "$"


class Gateway(Protocol):
    async def call(self, calls: list[tuple[str, dict[str, Any]]]) -> list[GatewayCall]:
        """Runs (tool kind, arguments) calls in order, in one MCP session."""
        ...


def parse_list(text: str) -> list[dict[str, Any]]:
    """Stripe answers with JSON text: a list, or an object with a `data` list."""
    try:
        parsed = json.loads(text)
    except ValueError:
        return []
    items = parsed if isinstance(parsed, list) else parsed.get("data") if isinstance(parsed, dict) else None
    return [item for item in items or [] if isinstance(item, dict)]


def to_payment(item: dict[str, Any]) -> Payment | None:
    if not isinstance(item.get("id"), str) or not isinstance(item.get("amount"), int):
        return None
    created = item.get("created")
    return Payment(
        id=item["id"],
        amount_cents=item["amount"],
        date=datetime.fromtimestamp(created, timezone.utc).date().isoformat() if isinstance(created, int) else "unknown",
        description=item.get("description") or "",
        metadata={str(key): str(value) for key, value in (item.get("metadata") or {}).items()},
        status=item.get("status") or "unknown",
    )


@dataclass
class Lookup:
    calls: list[GatewayCall]
    payments: list[Payment]
    reached: bool


async def lookup_payments(gateway: Gateway, email: str) -> Lookup:
    """Finds the customer by email, then lists their payments."""
    [customer_call] = await gateway.call([("list-customers", {"email": email, "limit": 1})])
    if not customer_call.ok:
        return Lookup([customer_call], [], reached=False)
    customer = next((item for item in parse_list(customer_call.result) if str(item.get("id", "")).startswith("cus_")), None)
    if not customer:
        return Lookup([customer_call], [], reached=True)

    [payments_call] = await gateway.call([("list-payment-intents", {"customer": customer["id"], "limit": 20})])
    payments = [payment for payment in map(to_payment, parse_list(payments_call.result)) if payment]
    return Lookup([customer_call, payments_call], payments, reached=payments_call.ok)


class McpGateway:
    """Calls the team's gateway server. One MCP session per batch of calls."""

    def __init__(self, url: str, token: str) -> None:
        self._url = url
        self._token = token

    async def call(self, calls: list[tuple[str, dict[str, Any]]]) -> list[GatewayCall]:
        results: list[GatewayCall] = []
        try:
            async with httpx.AsyncClient(headers={"Authorization": f"Bearer {self._token}"}, timeout=30) as http_client:
                async with streamable_http_client(self._url, http_client=http_client) as (read, write, _):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        tools = [tool.name for tool in (await session.list_tools()).tools]
                        for kind, arguments in calls:
                            name = next((tool for tool in tools if re.search(tool_pattern(kind), tool)), None)
                            if name is None:
                                results.append(GatewayCall(f"stripe-{kind}", arguments, False, f"The gateway has no {kind} tool"))
                                continue
                            result = await session.call_tool(name, arguments)
                            text = "\n".join(part.text for part in result.content if getattr(part, "type", "") == "text")
                            results.append(GatewayCall(name, arguments, not result.isError, text))
        except Exception as error:  # noqa: BLE001 - any failure reaching Stripe is reported as a failed call
            done = len(results)
            results.extend(GatewayCall(f"stripe-{kind}", arguments, False, str(error)) for kind, arguments in calls[done:])
        return results


class DisconnectedGateway:
    """For runs without a gateway: every call fails and says why."""

    async def call(self, calls: list[tuple[str, dict[str, Any]]]) -> list[GatewayCall]:
        return [
            GatewayCall(f"stripe-{kind}", arguments, False, "Stripe is not connected (GATEWAY_MCP_URL is not set)")
            for kind, arguments in calls
        ]


def calls_metadata(calls: list[GatewayCall]) -> list[dict[str, Any]]:
    return [asdict(call) for call in calls]
