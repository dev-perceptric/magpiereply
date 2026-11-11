"""Scores the last trial run with Ragas faithfulness: is each reply backed by the help articles it cited?
Run after trial.run_trial (CI does both, .github/workflows/brain-golden.yml):
    python -m trial.score_ragas [--min 0.75]

Each reply is judged against what Magpie was given: the help articles it cited plus its rules (sign in first, refund
timing, handoffs). Turns that called a tool are left out, because their facts come from Stripe and the trial doesn't
keep tool output; the code checks in run_trial cover those. Uses Haiku as the judge. About $0.05 a run.

Baseline on November 11, 2026: 0.84 over 21 replies, with 0 wrong answers in the trial. The judge is noisy (it scored a
reply that repeats its article almost word for word at 0.20), so the gate sits at 0.75: low enough that good changes
pass, high enough that a real drop fails.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path

import anthropic

from magpie_brain.engine import RULES

HERE = Path(__file__).resolve().parent
JUDGE_MODEL = "claude-haiku-5-5"
CONCURRENCY = 4


class NoSamplingClient(anthropic.AsyncAnthropic):
    """Ragas sends temperature on every call, which the current Claude SDK and models no longer take."""

    def __init__(self) -> None:
        super().__init__()
        create = self.messages.create

        async def without_sampling(*args, **kwargs):
            kwargs.pop("temperature", None)
            kwargs.pop("top_p", None)
            return await create(*args, **kwargs)

        self.messages.create = without_sampling


def latest_results() -> Path:
    runs = sorted((Path(os.environ.get("DATA_DIR", "/data")) / "trial").glob("*/results.json"))
    if not runs:
        raise SystemExit("No trial results found. Run python -m trial.run_trial first.")
    return runs[-1]


def scored_turns(report: dict, articles: dict[str, str]) -> list[dict]:
    turns = []
    for run in report["runs"]:
        for result in run["results"]:
            for turn in result.get("turns", []):
                cited = [articles[source["id"]] for source in turn.get("sources") or [] if source.get("id") in articles]
                if turn.get("reply") and cited and not turn.get("tools"):
                    turns.append({"case": result["id"], "user_input": turn["customer"], "response": turn["reply"], "contexts": [*cited, RULES]})
    return turns


async def main() -> None:
    from ragas.llms import llm_factory
    from ragas.metrics.collections import Faithfulness

    parser = argparse.ArgumentParser()
    parser.add_argument("--min", type=float, default=0.75, help="lowest average faithfulness that passes")
    args = parser.parse_args()

    articles = {row["id"]: f"{row['title']}\n\n{row['body']}" for row in json.loads((HERE / "articles.json").read_text())}
    path = latest_results()
    turns = scored_turns(json.loads(path.read_text()), articles)
    metric = Faithfulness(llm=llm_factory(JUDGE_MODEL, provider="anthropic", client=NoSamplingClient()))
    gate = asyncio.Semaphore(CONCURRENCY)

    async def score(turn: dict) -> float:
        async with gate:
            result = await metric.ascore(user_input=turn["user_input"], response=turn["response"], retrieved_contexts=turn["contexts"])
            return float(result.value)

    scores = await asyncio.gather(*(score(turn) for turn in turns))
    for turn, value in zip(turns, scores):
        if value < 0.7:
            print(f"[ragas] {turn['case']} faithfulness {value:.2f} :: {turn['response'][:120]}", flush=True)
    average = sum(scores) / len(scores) if scores else 0.0
    print(f"[ragas] faithfulness {average:.3f} over {len(scores)} article replies ({path})", flush=True)
    if not scores or average < args.min:
        print(f"[ragas] [fail] faithfulness under {args.min}", flush=True)
        raise SystemExit(1)
    print(f"[ragas] [pass] faithfulness at least {args.min}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
