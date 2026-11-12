"""Settings for the brain, read once at start. A missing required value stops the process."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    # Shared secret for every caller (the bridge and the trial runner).
    api_key: str
    data_dir: Path
    port: int
    # For a team that hasn't connected its own Stripe: "none" (production: no charge lookups), "fixture" (the trial's
    # made-up customers, for tests) or "gateway" (one shared Stripe MCP server; the trial only).
    stripe_mode: str
    gateway_url: str | None
    gateway_token: str | None
    reply_model: str
    # The small model for the fact check and handoff notes.
    review_model: str
    # FlashRank's re-ranking model, downloaded into the image at build time.
    rerank_model: str
    rerank_cache: str
    # Presidio masking of card, ID and contact numbers before Claude. On unless MASK_PERSONAL_DATA=off.
    mask_personal_data: bool


def load_config(env: os._Environ[str] | dict[str, str] = os.environ) -> Config:
    problems: list[str] = []
    for required in ("BRAIN_API_KEY", "ANTHROPIC_API_KEY", "VOYAGE_API_KEY"):
        if not env.get(required):
            problems.append(f"{required} is required")

    stripe_mode = env.get("STRIPE_MODE", "fixture")
    if stripe_mode not in ("none", "fixture", "gateway"):
        problems.append("STRIPE_MODE must be none, fixture or gateway")
    if stripe_mode == "gateway" and not (env.get("GATEWAY_URL") and env.get("GATEWAY_TOKEN")):
        problems.append("STRIPE_MODE=gateway needs GATEWAY_URL and GATEWAY_TOKEN")

    if problems:
        raise RuntimeError("Invalid configuration:\n" + "\n".join(problems))

    return Config(
        api_key=env["BRAIN_API_KEY"],
        data_dir=Path(env.get("DATA_DIR", "/data")),
        port=int(env.get("PORT", "8800")),
        stripe_mode=stripe_mode,
        gateway_url=env.get("GATEWAY_URL"),
        gateway_token=env.get("GATEWAY_TOKEN"),
        reply_model=env.get("REPLY_MODEL", "claude-sonnet-5-5"),
        review_model=env.get("REVIEW_MODEL", "claude-haiku-5-5"),
        rerank_model=env.get("RERANK_MODEL", "ms-marco-MiniLM-L-12-v2"),
        rerank_cache=env.get("RERANK_CACHE", "/opt/flashrank"),
        mask_personal_data=env.get("MASK_PERSONAL_DATA", "on") != "off",
    )
