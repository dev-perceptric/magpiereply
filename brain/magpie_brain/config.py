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
    # "gateway" calls Stripe through the MCP gateway; "fixture" uses the trial's made-up Stripe data.
    stripe_mode: str
    gateway_url: str | None
    gateway_token: str | None
    reply_model: str


def load_config(env: os._Environ[str] | dict[str, str] = os.environ) -> Config:
    problems: list[str] = []
    for required in ("BRAIN_API_KEY", "ANTHROPIC_API_KEY", "VOYAGE_API_KEY"):
        if not env.get(required):
            problems.append(f"{required} is required")

    stripe_mode = env.get("STRIPE_MODE", "fixture")
    if stripe_mode not in ("fixture", "gateway"):
        problems.append("STRIPE_MODE must be fixture or gateway")
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
    )
