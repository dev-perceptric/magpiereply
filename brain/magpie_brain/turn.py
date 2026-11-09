"""One conversation turn through Parlant, for the bridge and the trial runner.

The bridge sends the new customer messages of a MagpieReply conversation. The brain keeps one
Parlant session per conversation, posts the messages, waits for the reply and returns it with
the tools it used, any refund it proposed, any handoff and what the turn cost.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Sequence

import httpx
from pydantic import BaseModel, Field

from .agent import AGENT_ID

REPLY_TIMEOUT_SECONDS = 90


class TurnCustomer(BaseModel):
    id: str = Field(min_length=1)
    name: str = "Customer"
    email: str | None = None
    verified: bool = False


class TurnMessage(BaseModel):
    id: str = Field(min_length=1)
    content: str = Field(min_length=1)


class TurnRequest(BaseModel):
    team_id: str = Field(min_length=1)
    conversation_id: str = Field(min_length=1)
    session_id: str | None = None
    customer: TurnCustomer
    messages: list[TurnMessage] = Field(min_length=1)
    persona: bool = False  # trial customers are personas, so they can never be signed in as


@dataclass
class TurnResult:
    session_id: str
    replies: list[str] = field(default_factory=list)
    tools: list[dict[str, Any]] = field(default_factory=list)
    proposals: list[dict[str, Any]] = field(default_factory=list)
    handoff: dict[str, Any] | None = None
    already_with_people: bool = False
    seconds: float = 0.0
    cost_usd: str | None = None
    tokens: dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "reply": "\n\n".join(self.replies) or None,
            "tools": self.tools,
            "proposals": self.proposals,
            "handoff": self.handoff,
            "already_with_people": self.already_with_people,
            "seconds": round(self.seconds, 2),
            "cost_usd": self.cost_usd,
            "tokens": self.tokens,
        }


def tool_name(tool_id: str) -> str:
    """Parlant tool ids look like "service:name"."""
    return tool_id.rsplit(":", 1)[-1]


def read_events(result: TurnResult, events: Sequence[dict[str, Any]]) -> None:
    """Collects the agent's messages, tool calls, proposals and handoff from a turn's events."""
    for event in events:
        if event["kind"] == "message" and event["source"] == "ai_agent":
            message = (event.get("data") or {}).get("message")
            if message:
                result.replies.append(message)
        if event["kind"] == "tool":
            for call in (event.get("data") or {}).get("tool_calls", []):
                name = tool_name(call.get("tool_id", ""))
                data = ((call.get("result") or {}).get("data")) or {}
                refused = data.get("error") if isinstance(data, dict) else None
                result.tools.append({"name": name, "arguments": call.get("arguments") or {}, "refused": refused})
                if isinstance(data, dict) and data.get("proposal"):
                    result.proposals.append(data["proposal"])
                if isinstance(data, dict) and data.get("handoff"):
                    result.handoff = data["handoff"]


def turn_finished(events: Sequence[dict[str, Any]], trace_id: str) -> bool:
    return any(
        event["kind"] == "status"
        and event.get("trace_id") == trace_id
        and (event.get("data") or {}).get("status") in ("ready", "error", "cancelled")
        for event in events
    )


def add_usage(result: TurnResult, session: dict[str, Any], earlier: set[str]) -> None:
    """Adds up the tokens and cost of every usage record Parlant wrote during this turn (keys not in `earlier`).
    A new session's prompt-cache warm-up lands in its first turn, as it should."""
    usage = session.get("usage") or {}
    total = Decimal("0")
    priced = True
    new = [key for key in usage if key not in earlier]
    for key in new:
        record = usage[key]
        for model in (record.get("requests") or {}).values():
            for key in ("input_tokens", "cached_input_tokens", "output_tokens"):
                result.tokens[key] = result.tokens.get(key, 0) + int(model.get(key) or 0)
        costs = record.get("costs")
        if costs is None:
            priced = False
        else:
            total += Decimal(str(costs.get("total") or 0))
    result.cost_usd = f"{total:.5f}" if priced and new else None


class ParlantClient:
    """Parlant's own HTTP API, called on localhost with the admin key."""

    def __init__(self, base_url: str, admin_key: str):
        self._http = httpx.AsyncClient(
            base_url=base_url, headers={"authorization": f"Bearer {admin_key}"}, timeout=REPLY_TIMEOUT_SECONDS
        )

    async def close(self) -> None:
        await self._http.aclose()

    async def _call(self, method: str, path: str, **kwargs: Any) -> Any:
        response = await self._http.request(method, path, **kwargs)
        response.raise_for_status()
        return response.json() if response.content else None

    async def ensure_customer(self, request: TurnRequest) -> str:
        customer_id = f"t{request.team_id}-c{request.customer.id}"
        metadata = {
            "team_id": request.team_id,
            "email": request.customer.email or "",
            "verified": "true" if request.customer.verified and request.customer.email else "false",
        }
        found = await self._http.get(f"/customers/{customer_id}")
        if found.status_code == 404:
            await self._call(
                "POST",
                "/customers",
                json={
                    "id": customer_id,
                    "name": request.customer.name,
                    "metadata": metadata,
                    "kind": "persona" if request.persona else "real",
                },
            )
        else:
            found.raise_for_status()
            await self._call("PATCH", f"/customers/{customer_id}", json={"metadata": {"set": metadata}})
        return customer_id

    async def run(self, request: TurnRequest) -> TurnResult:
        started = time.monotonic()
        customer_id = await self.ensure_customer(request)

        if request.session_id:
            session = await self._call("GET", f"/sessions/{request.session_id}")
        else:
            session = await self._call(
                "POST",
                "/sessions",
                json={
                    "agent_id": AGENT_ID,
                    "customer_id": customer_id,
                    "metadata": {"team_id": request.team_id, "conversation_id": request.conversation_id},
                },
            )
        result = TurnResult(session_id=session["id"])
        earlier = set(session.get("usage") or {})
        if session["mode"] == "manual":
            result.already_with_people = True
            return result

        posted = [
            await self._call(
                "POST",
                f"/sessions/{result.session_id}/events",
                json={
                    "kind": "message",
                    "source": "customer",
                    "message": message.content,
                    "metadata": {"app_message_id": message.id},
                },
            )
            for message in request.messages
        ]
        start_offset = posted[0]["offset"]
        last_trace = posted[-1]["trace_id"]

        events: list[dict[str, Any]] = []
        deadline = started + REPLY_TIMEOUT_SECONDS
        while not turn_finished(events, last_trace):
            if time.monotonic() > deadline:
                raise TimeoutError(f"No reply within {REPLY_TIMEOUT_SECONDS} seconds")
            next_offset = events[-1]["offset"] + 1 if events else start_offset
            response = await self._http.get(
                f"/sessions/{result.session_id}/events", params={"min_offset": next_offset, "wait_for_data": 15}
            )
            if response.status_code == 504:
                continue
            response.raise_for_status()
            events.extend(response.json())
            await asyncio.sleep(0)

        read_events(result, events)
        result.seconds = time.monotonic() - started
        session = await self._call("GET", f"/sessions/{result.session_id}")
        add_usage(result, session, earlier)
        return result
