"""Starts the brain: Parlant with the Magpie agent, plus the routes the bridge and the trial call.

Routes (all need "Authorization: Bearer <BRAIN_API_KEY>" except health):
- GET  /healthz                       Parlant's own health, also used by Docker
- PUT  /magpie/knowledge/{team_id}    replace a team's help articles
- POST /magpie/turn                   one conversation turn through Parlant
- POST /magpie/baseline               the same turn through the one-prompt baseline (trial only)
"""

from __future__ import annotations

import asyncio
import hmac
import os
from decimal import Decimal
from pathlib import Path

from . import compat  # noqa: F401  (must load before Parlant builds its Anthropic clients)

import anthropic
import parlant.sdk as p
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .agent import Deps, build_agent, set_deps
from .baseline import BaselineRequest, run_baseline
from .config import load_config
from .knowledge import Article, KnowledgeStore, voyage_embedder
from .stripe import FixtureStripe, GatewayStripe
from .turn import ParlantClient, TurnRequest

FIXTURE_PATH = Path(__file__).resolve().parent.parent / "trial" / "stripe_fixture.json"

# Dollars per million tokens (omniscient/scripts/cost-model.mjs, October 2026). Haiku's cache price is "check".
PRICING = {
    "claude-haiku-5-5": p.ModelPricing(
        input_tokens=Decimal("0.1"), cached_input_tokens=Decimal("0.01"), output_tokens=Decimal("0.5")
    ),
    "claude-sonnet-5-5": p.ModelPricing(
        input_tokens=Decimal("2.0"), cached_input_tokens=Decimal("0.2"), output_tokens=Decimal("10.0")
    ),
    "claude-opus-5-5": p.ModelPricing(
        input_tokens=Decimal("4.0"), cached_input_tokens=Decimal("0.2"), output_tokens=Decimal("20.0")
    ),
    "voyage-3.5": p.ModelPricing(input_tokens=Decimal("0.06"), cached_input_tokens=Decimal("0.06"), output_tokens=Decimal("0")),
}


class KnowledgeBody(BaseModel):
    articles: list[Article] = Field(default_factory=list)


async def main() -> None:
    config = load_config()
    os.environ.setdefault("PARLANT_HOME", str(config.data_dir / "parlant"))

    knowledge = KnowledgeStore(config.data_dir / "knowledge", voyage_embedder(os.environ["VOYAGE_API_KEY"]))
    stripe = (
        GatewayStripe(config.gateway_url or "", config.gateway_token or "")
        if config.stripe_mode == "gateway"
        else FixtureStripe(FIXTURE_PATH)
    )
    set_deps(Deps(knowledge=knowledge, stripe=stripe))
    claude = anthropic.AsyncAnthropic()
    parlant = ParlantClient(f"http://127.0.0.1:{config.port}", config.api_key)

    def require_key(authorization: str = Header(default="")) -> None:
        if not hmac.compare_digest(authorization, f"Bearer {config.api_key}"):
            raise HTTPException(status_code=401, detail="unauthorized")

    async def configure_api(api: FastAPI) -> None:
        @api.put("/magpie/knowledge/{team_id}", dependencies=[Depends(require_key)])
        async def put_knowledge(team_id: str, body: KnowledgeBody) -> dict[str, int]:
            pieces = await knowledge.replace(team_id, body.articles)
            return {"articles": len(body.articles), "pieces": pieces}

        @api.post("/magpie/turn", dependencies=[Depends(require_key)])
        async def post_turn(body: TurnRequest) -> dict:
            return (await parlant.run(body)).as_dict()

        @api.post("/magpie/baseline", dependencies=[Depends(require_key)])
        async def post_baseline(body: BaselineRequest) -> dict:
            return await run_baseline(body, knowledge, stripe, claude, config.reply_model)

    async with p.Server(
        port=config.port,
        models={"*": "anthropic"},
        auth=p.AuthConfig(admin_api_key=config.api_key),
        session_store="local",
        customer_store="local",
        hot_reload=False,
        configure_api=configure_api,
    ) as server:
        await server.set_pricing(PRICING, currency="USD")
        await build_agent(server, config.reply_model, config.check_model)
        print(f"[brain] ready on port {config.port}, Stripe from {config.stripe_mode}", flush=True)

    await parlant.close()


if __name__ == "__main__":
    asyncio.run(main())
