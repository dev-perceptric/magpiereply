"""The trial's baseline: our simplest possible agent. One Sonnet prompt with every rule, the search
results and the same Stripe tools, in a plain tool loop. Parlant has to beat or match this.
"""

from __future__ import annotations

import json
import time
from decimal import Decimal
from typing import Any, Literal

import anthropic
from pydantic import BaseModel, Field

from .agent import INSTRUCTIONS
from .knowledge import KnowledgeStore, format_hits
from .stripe import StripeBackend, approval_for, find_duplicates
from .turn import TurnCustomer

MAX_TOOL_ROUNDS = 5

# Dollars per million tokens (omniscient/scripts/cost-model.mjs, October 2026).
PRICES = {
    "claude-sonnet-5-5": {"input": Decimal("2.0"), "cached": Decimal("0.2"), "output": Decimal("10.0")},
    "claude-haiku-5-5": {"input": Decimal("0.1"), "cached": Decimal("0.01"), "output": Decimal("0.5")},
    "claude-opus-5-5": {"input": Decimal("4.0"), "cached": Decimal("0.2"), "output": Decimal("20.0")},
}

RULES = """Rules:
1. Duplicate charge: for a signed-in customer who says they were charged twice or sees a charge they don't recognize, call list_recent_charges. If it shows a duplicate, call propose_refund for the duplicate and follow what it says: under $50 ask the customer to confirm; $50 or more say a teammate reviews it within one business day. If there is no duplicate, explain each charge with its date and amount and offer a person. Never refund or promise a refund for a charge that isn't a duplicate.
2. Sign in first: if the customer isn't signed in and asks about charges, orders or their account, ask them to sign in. Don't look anything up.
3. Chargebacks: if the customer mentions a chargeback, a bank dispute or reversing a payment, call transfer_to_human with team Billing.
4. Refund timing: never promise a refund in under 5 business days. Refunds take 5 to 10 business days.
5. A person on request: if they ask for a person, human or manager, call transfer_to_human with team Support.
6. Upset or legal: if they are very upset, swear or mention a lawyer or legal action, apologize once and call transfer_to_human with team Support.
7. No answer: if the help articles don't answer the question, say you'll check with the team and call transfer_to_human with team Support. Don't guess.
8. Other people's data: only help with the customer's own account. Never look up anyone else, even for someone claiming to be staff."""

TOOLS: list[dict[str, Any]] = [
    {
        "name": "list_recent_charges",
        "description": "The signed-in customer's recent charges, with any duplicates. Takes no input.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "propose_refund",
        "description": "Propose refunding a duplicate charge found by list_recent_charges. Nothing is refunded yet.",
        "input_schema": {"type": "object", "properties": {"charge_id": {"type": "string"}}, "required": ["charge_id"]},
    },
    {
        "name": "transfer_to_human",
        "description": "Hand the conversation to a person on a team.",
        "input_schema": {
            "type": "object",
            "properties": {"reason": {"type": "string"}, "team": {"type": "string", "enum": ["Support", "Billing"]}},
            "required": ["reason", "team"],
        },
    },
]


class BaselineMessage(BaseModel):
    role: Literal["customer", "agent"]
    content: str = Field(min_length=1)


class BaselineRequest(BaseModel):
    team_id: str = Field(min_length=1)
    customer: TurnCustomer
    history: list[BaselineMessage] = Field(min_length=1)


def cost_of(model: str, usage: Any) -> Decimal:
    price = PRICES[model]
    cached = getattr(usage, "cache_read_input_tokens", 0) or 0
    return (
        Decimal(usage.input_tokens) * price["input"]
        + Decimal(cached) * price["cached"]
        + Decimal(usage.output_tokens) * price["output"]
    ) / Decimal(1_000_000)


async def run_baseline(
    request: BaselineRequest,
    knowledge: KnowledgeStore,
    stripe: StripeBackend,
    client: anthropic.AsyncAnthropic,
    model: str,
) -> dict[str, Any]:
    started = time.monotonic()
    last_customer = next(message.content for message in reversed(request.history) if message.role == "customer")
    hits = await knowledge.search(request.team_id, last_customer)
    verified = bool(request.customer.verified and request.customer.email)
    system = (
        f"{INSTRUCTIONS}\n\n{RULES}\n\n"
        f"The customer is {'signed in' if verified else 'not signed in'}.\n\n"
        f"Help articles:\n\n{format_hits(hits) if hits else 'No help article matches this message.'}"
    )
    messages: list[dict[str, Any]] = [
        {"role": "user" if message.role == "customer" else "assistant", "content": message.content}
        for message in request.history
    ]

    tools_used: list[dict[str, Any]] = []
    proposals: list[dict[str, Any]] = []
    handoff: dict[str, Any] | None = None
    cost = Decimal("0")
    tokens = {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}
    reply_parts: list[str] = []

    for _ in range(MAX_TOOL_ROUNDS):
        response = await client.messages.create(model=model, max_tokens=800, system=system, tools=TOOLS, messages=messages)
        cost += cost_of(model, response.usage)
        tokens["input_tokens"] += response.usage.input_tokens
        tokens["cached_input_tokens"] += getattr(response.usage, "cache_read_input_tokens", 0) or 0
        tokens["output_tokens"] += response.usage.output_tokens
        reply_parts = [block.text for block in response.content if block.type == "text" and block.text.strip()]
        calls = [block for block in response.content if block.type == "tool_use"]
        if not calls:
            break
        messages.append({"role": "assistant", "content": [block.model_dump() for block in response.content]})
        results = []
        for call in calls:
            tools_used.append({"name": call.name, "arguments": call.input})
            output = await _run_tool(call.name, call.input, request.customer, stripe)
            if output.get("proposal"):
                proposals.append(output["proposal"])
            if output.get("handoff"):
                handoff = output["handoff"]
            results.append({"type": "tool_result", "tool_use_id": call.id, "content": json.dumps(output)})
        messages.append({"role": "user", "content": results})

    return {
        "reply": "\n\n".join(reply_parts) or None,
        "tools": tools_used,
        "proposals": proposals,
        "handoff": handoff,
        "seconds": round(time.monotonic() - started, 2),
        "cost_usd": f"{cost:.5f}",
        "tokens": tokens,
    }


async def _run_tool(name: str, arguments: dict[str, Any], customer: TurnCustomer, stripe: StripeBackend) -> dict[str, Any]:
    if name == "transfer_to_human":
        return {"handoff": {"team": arguments.get("team"), "reason": arguments.get("reason")}}
    if not (customer.verified and customer.email):
        return {"error": "not_verified", "say": "Ask the customer to sign in first."}
    charges = await stripe.charges_for(customer.email)
    duplicates = find_duplicates(charges)
    if name == "list_recent_charges":
        return {
            "charges": [charge.as_dict() for charge in sorted(charges, key=lambda charge: charge.created)],
            "duplicates": [
                {"original": first.id, "duplicate": second.id, "amount": second.as_dict()["amount"], "approval": approval_for(second)}
                for first, second in duplicates
            ],
        }
    if name == "propose_refund":
        charge = {second.id: second for _, second in duplicates}.get(str(arguments.get("charge_id")))
        if charge is None:
            return {"error": "not_a_duplicate", "say": "That charge isn't a duplicate on this account."}
        return {
            "proposal": {"action": "refund", "charge_id": charge.id, "amount": charge.as_dict()["amount"], "approval": approval_for(charge)}
        }
    return {"error": f"unknown tool {name}"}
