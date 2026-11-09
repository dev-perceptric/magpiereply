"""Stripe for the trial: read a verified customer's recent charges and spot duplicates.

Two backends give the same answers. "gateway" calls Stripe's MCP server through the team's
ContextForge bundle. "fixture" reads the trial's made-up customers, so the trial can run before
Stripe is connected. Nothing here moves money: refunds are only proposed.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol, Sequence

from fastmcp.client import Client
from fastmcp.client.transports import StreamableHttpTransport

DUPLICATE_WINDOW_SECONDS = 24 * 60 * 60
STAFF_APPROVAL_FROM_CENTS = 5000


@dataclass(frozen=True)
class Charge:
    id: str
    amount_cents: int
    currency: str
    created: int  # unix seconds
    description: str
    refunded: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "amount": f"{self.amount_cents / 100:.2f} {self.currency.upper()}",
            "date": datetime.fromtimestamp(self.created, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
            "description": self.description,
            "refunded": self.refunded,
        }


class StripeBackend(Protocol):
    async def charges_for(self, email: str) -> list[Charge]: ...


def find_duplicates(charges: Sequence[Charge]) -> list[tuple[Charge, Charge]]:
    """Pairs of charges with the same amount and description within 24 hours. The later one is the duplicate."""
    ordered = sorted((charge for charge in charges if not charge.refunded), key=lambda charge: charge.created)
    pairs: list[tuple[Charge, Charge]] = []
    used: set[str] = set()
    for index, first in enumerate(ordered):
        for second in ordered[index + 1 :]:
            if second.id in used or first.id in used:
                continue
            same = first.amount_cents == second.amount_cents and first.description == second.description
            if same and second.created - first.created <= DUPLICATE_WINDOW_SECONDS:
                pairs.append((first, second))
                used.add(second.id)
    return pairs


def approval_for(charge: Charge) -> str:
    return "staff_approves" if charge.amount_cents >= STAFF_APPROVAL_FROM_CENTS else "customer_confirms"


class FixtureStripe:
    def __init__(self, path: Path):
        rows = json.loads(path.read_text())
        self._charges = {
            customer["email"].lower(): [Charge(**charge) for charge in customer["charges"]] for customer in rows
        }

    async def charges_for(self, email: str) -> list[Charge]:
        return list(self._charges.get(email.lower(), []))


def _tool_named(names: Sequence[str], wanted: str) -> str:
    """Gateways prefix tool names (for example "stripe-list-customers"); match on the ending."""
    wanted_key = re.sub(r"[^a-z]", "", wanted)
    for name in names:
        if re.sub(r"[^a-z]", "", name.lower()).endswith(wanted_key):
            return name
    raise LookupError(f"The gateway has no {wanted} tool. It has: {', '.join(names)}")


def _result_json(result: Any) -> Any:
    if result.structured_content:
        return result.structured_content
    for block in result.content:
        text = getattr(block, "text", None)
        if text:
            return json.loads(text)
    return None


def _rows(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("data", "result", "results"):
            if isinstance(payload.get(key), list):
                return payload[key]
    return []


REDACTED = "[REDACTED]"


def _same_customer(customer: dict[str, Any], email: str) -> bool:
    """Stripe's email filter is an exact match on Stripe's side. Stripe's MCP server hides the email in its
    answer, so a hidden email from that filtered search is the customer we asked for; a visible one must match."""
    shown = str(customer.get("email") or "")
    return shown == REDACTED or shown.lower() == email.lower()


class GatewayStripe:
    def __init__(self, url: str, token: str):
        self._url = url
        self._token = token

    async def charges_for(self, email: str) -> list[Charge]:
        transport = StreamableHttpTransport(self._url, headers={"authorization": f"Bearer {self._token}"})
        async with Client(transport) as client:
            names = [tool.name for tool in await client.list_tools()]

            async def read(operation: str, legacy_tool: str, parameters: dict[str, Any]) -> list[dict[str, Any]]:
                # Stripe's own MCP server has one generic read tool; older servers and gateways have one tool per list.
                if "stripe_api_read" in names:
                    call = await client.call_tool("stripe_api_read", {"stripe_api_operation_id": operation, "parameters": parameters})
                else:
                    call = await client.call_tool(_tool_named(names, legacy_tool), parameters)
                return _rows(_result_json(call))

            customers = await read("GetCustomers", "list_customers", {"email": email, "limit": 10})
            charges: list[Charge] = []
            for customer in customers:
                if not _same_customer(customer, email):
                    continue  # never trust a loose match on someone else's account
                for intent in await read("GetPaymentIntents", "list_payment_intents", {"customer": customer["id"], "limit": 20}):
                    if intent.get("status") != "succeeded":
                        continue
                    charges.append(
                        Charge(
                            id=intent["id"],
                            amount_cents=int(intent.get("amount_received") or intent["amount"]),
                            currency=intent.get("currency", "usd"),
                            created=int(intent["created"]),
                            description=intent.get("description") or "",
                            refunded=bool(intent.get("amount_refunded")),
                        )
                    )
            return charges
