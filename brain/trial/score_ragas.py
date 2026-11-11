"""Scores the last trial run with Ragas faithfulness: is each reply backed by the help articles it cited?
Run after trial.run_trial (CI does both, .github/workflows/brain-golden.yml):
    python -m trial.score_ragas [--min 0.85]

Turns without cited articles (tool answers, handoffs) are left out: faithfulness needs the text the reply leaned on.
Uses Haiku as the judge. About $0.05 a run.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path

import anthropic

HERE = Path(__file__).resolve().parent
JUDGE_MODEL = "claude-haiku-5-5"
CONCURRENCY = 4


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
                contexts = [articles[source["id"]] for source in turn.get("sources") or [] if source.get("id") in articles]
                if turn.get("reply") and contexts:
                    turns.append({"case": result["id"], "user_input": turn["customer"], "response": turn["reply"], "contexts": contexts})
    return turns


async def main() -> None:
    from ragas.llms import llm_factory
    from ragas.metrics.collections import Faithfulness

    parser = argparse.ArgumentParser()
    parser.add_argument("--min", type=float, default=0.85, help="lowest average faithfulness that passes")
    args = parser.parse_args()

    articles = {row["id"]: f"{row['title']}\n\n{row['body']}" for row in json.loads((HERE / "articles.json").read_text())}
    path = latest_results()
    turns = scored_turns(json.loads(path.read_text()), articles)
    metric = Faithfulness(llm=llm_factory(JUDGE_MODEL, provider="anthropic", client=anthropic.AsyncAnthropic()))
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
    print(f"[ragas] faithfulness {average:.3f} over {len(scores)} replies with sources ({path})", flush=True)
    if not scores or average < args.min:
        print(f"[ragas] [fail] faithfulness under {args.min}", flush=True)
        raise SystemExit(1)
    print(f"[ragas] [pass] faithfulness at least {args.min}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
