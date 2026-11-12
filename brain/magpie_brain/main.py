"""Starts the brain: the Magpie engine behind a small web API.

Routes (all need "Authorization: Bearer <BRAIN_API_KEY>" except health):
- GET  /healthz                       {"status": "healthy"}, for Docker
- PUT  /magpie/knowledge/{team_id}    replace a team's knowledge (help center, website pages and files)
- POST /magpie/reply                  one reply: the conversation so far in; the reply, its sources, the fact check,
                                      the attack check, tools, proposals, handoff and handoff note out
- POST /magpie/grade                  replay tests: Magpie's reply now against the one a teammate sent
"""

import hmac
import os
from pathlib import Path

import anthropic
import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .config import load_config
from .engine import GradeRequest, ReplyRequest, grade_reply, run_reply
from .knowledge import Article, KnowledgeStore, flashrank_reranker, voyage_embedder
from .safety import presidio_mask
from .stripe import FixtureStripe, GatewayStripe

FIXTURE_PATH = Path(__file__).resolve().parent.parent / "trial" / "stripe_fixture.json"


class KnowledgeBody(BaseModel):
    articles: list[Article] = Field(default_factory=list)


def create_app() -> FastAPI:
    config = load_config()
    knowledge = KnowledgeStore(
        config.data_dir / "knowledge",
        voyage_embedder(os.environ["VOYAGE_API_KEY"]),
        flashrank_reranker(config.rerank_model, config.rerank_cache),
    )
    # A team's own Stripe comes with each request; this is only for teams that haven't connected one.
    stripe = {
        "none": None,
        "fixture": FixtureStripe(FIXTURE_PATH),
        "gateway": GatewayStripe(config.gateway_url or "", config.gateway_token or ""),
    }[config.stripe_mode]
    claude = anthropic.AsyncAnthropic()
    mask = presidio_mask() if config.mask_personal_data else None
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
        return await run_reply(body, knowledge, stripe, claude, config.reply_model, config.review_model, mask)

    @api.post("/magpie/grade", dependencies=[Depends(require_key)])
    async def post_grade(body: GradeRequest) -> dict:
        return await grade_reply(body, claude, config.review_model)

    print(
        f"[brain] ready on port {config.port}, Stripe for unconnected teams: {config.stripe_mode}, "
        f"masking {'on' if mask else 'off'}",
        flush=True,
    )
    return api


if __name__ == "__main__":
    uvicorn.run(create_app(), host="0.0.0.0", port=load_config().port, log_level="warning")
