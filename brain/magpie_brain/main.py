"""Starts the brain: the Magpie engine behind a small web API.

Routes (all need "Authorization: Bearer <BRAIN_API_KEY>" except health):
- GET  /healthz                       {"status": "healthy"}, for Docker
- PUT  /magpie/knowledge/{team_id}    replace a team's help articles
- POST /magpie/reply                  one reply: the conversation so far in, the reply, tools, proposals and handoff out
"""

import hmac
import os
from pathlib import Path

import anthropic
import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .config import load_config
from .engine import ReplyRequest, run_reply
from .knowledge import Article, KnowledgeStore, voyage_embedder
from .stripe import FixtureStripe, GatewayStripe

FIXTURE_PATH = Path(__file__).resolve().parent.parent / "trial" / "stripe_fixture.json"


class KnowledgeBody(BaseModel):
    articles: list[Article] = Field(default_factory=list)


def create_app() -> FastAPI:
    config = load_config()
    knowledge = KnowledgeStore(config.data_dir / "knowledge", voyage_embedder(os.environ["VOYAGE_API_KEY"]))
    stripe = (
        GatewayStripe(config.gateway_url or "", config.gateway_token or "")
        if config.stripe_mode == "gateway"
        else FixtureStripe(FIXTURE_PATH)
    )
    claude = anthropic.AsyncAnthropic()
    api = FastAPI(title="Magpie brain")

    def require_key(authorization: str = Header(default="")) -> None:
        if not hmac.compare_digest(authorization, f"Bearer {config.api_key}"):
            raise HTTPException(status_code=401, detail="unauthorized")

    @api.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "healthy"}

    @api.put("/magpie/knowledge/{team_id}", dependencies=[Depends(require_key)])
    async def put_knowledge(team_id: str, body: KnowledgeBody) -> dict[str, int]:
        pieces = await knowledge.replace(team_id, body.articles)
        return {"articles": len(body.articles), "pieces": pieces}

    @api.post("/magpie/reply", dependencies=[Depends(require_key)])
    async def post_reply(body: ReplyRequest) -> dict:
        return await run_reply(body, knowledge, stripe, claude, config.reply_model)

    print(f"[brain] ready on port {config.port}, Stripe from {config.stripe_mode}", flush=True)
    return api


if __name__ == "__main__":
    uvicorn.run(create_app(), host="0.0.0.0", port=load_config().port, log_level="warning")
