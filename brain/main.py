"""magpie-brain: the Parlant server for the trial (docs/phase-0.md, Days 8 and 9).

Settings come from the environment:
  ANTHROPIC_API_KEY, VOYAGE_API_KEY   Claude for the agent, Voyage for Parlant's search vectors
  PARLANT_ENV=production, PARLANT_ADMIN_API_KEY   the API needs the admin key (the bridge has it)
  GATEWAY_MCP_URL, GATEWAY_TOKEN      the test team's gateway server, for Stripe
  PARLANT_HOME                        where Parlant keeps its local storage (a Fly volume)
"""

from __future__ import annotations

import asyncio
import os

import parlant.sdk as p

from stripe_gateway import DisconnectedGateway, McpGateway
from tidewell import create_tidewell_agent, set_gateway

REPLY_MODEL = os.environ.get("BRAIN_REPLY_MODEL", "anthropic:claude-sonnet-5-5")
SMALL_MODEL = os.environ.get("BRAIN_SMALL_MODEL", "anthropic:claude-haiku-5-5")

# Sonnet writes the replies; Haiku matches rules, reviews tool calls and builds indexes.
MODELS = {
    "*": "anthropic",
    "react": p.ModelConfig(REPLY_MODEL),
    "indexing": p.ModelConfig(SMALL_MODEL),
    "matching.rank": p.ModelConfig(SMALL_MODEL),
    "review.tools": p.ModelConfig(SMALL_MODEL),
    "review.message": p.ModelConfig(SMALL_MODEL),
    "compaction": p.ModelConfig(SMALL_MODEL),
}


def gateway_from_env() -> McpGateway | DisconnectedGateway:
    url = os.environ.get("GATEWAY_MCP_URL")
    if not url:
        print("GATEWAY_MCP_URL is not set: Stripe calls will fail.")
        return DisconnectedGateway()
    return McpGateway(url, os.environ["GATEWAY_TOKEN"])


async def main() -> None:
    set_gateway(gateway_from_env())
    async with p.Server(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8800")),
        models=MODELS,
        session_store="local",
        customer_store="local",
        hot_reload=False,
        migrate=True,
    ) as server:
        await create_tidewell_agent(server)


if __name__ == "__main__":
    asyncio.run(main())
