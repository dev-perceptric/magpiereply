# 0001: The brain is our own engine, not Parlant

November 9, 2026. Phase 0 trial, `docs/phase-0.md` day 10.

## Decision

**No-go for Parlant.** The brain is the Magpie engine (`brain/magpie_brain/engine.py`): one Sonnet call with the team's rules, the matching help articles and the tools, in a plain tool loop. It's the trial's one-prompt baseline, promoted. It stays a Python service beside the bridge, because the knowledge search, the Stripe MCP client and the trial already live there and passed; the plan's TypeScript fallback would have rewritten them for no gain.

## The numbers

40 test conversations (`brain/trial/cases.json`), graded by code (handoff, team, refund, approval level) and by Haiku against the expected outcome and the articles. Real Stripe test data through Stripe's MCP server.

| Measure | Go rule | Parlant 4.0.3 (best run) | Magpie engine |
|---|---|---|---|
| Correct | | 37 of 40 | 39 of 40 |
| Wrong | at most 2, and no more than the baseline | 2 to 3 | 1 to 5 across runs, mostly grader misses (see below) |
| Rule and attack tests | 10 of 10 | 9 of 10 | 10 of 10 |
| Slowest 5% of turns | under 10 s | 16 to 19 s | 4 to 6 s |
| Typical turn | | 10 to 14 s | 2.5 to 2.7 s |
| Cost per turn | under $0.03 | about $0.0003 (check) | about $0.0067 |
| Stripe over MCP | works | works | works |

Parlant failed the speed rule on every run, and nothing we could change brought it under:

- **Rule matching:** about 5 s and 9 to 14 Haiku calls per turn, before the reply starts.
- **Reply writing:** 5 to 8 s. Claude 5.5 models always think first, and that can't be turned off.
- **Its reply check:** rewrote some drafts up to 5 times (29 s on one turn). With it off, turns still took 12 to 15 s. Lower effort didn't help either.

## Surprises

- **Parlant 4.0.3 and the current Anthropic SDK don't agree on timeouts.** The SDK moved to httpx2, and the older SDK mis-assembled Sonnet 5.5's streamed thinking.
- **Anthropic refused Parlant's replayed thinking blocks** after every tool call, because Parlant rebuilds the prompt between steps. The fix was Anthropic's `drop_block` setting.
- **Parlant 4's customer metadata `.get()` is async.** Reading it the usual way made every customer look signed out.
- **Stripe's MCP server changed.** It now has one generic `stripe_api_read` tool, and it hides customer emails. The engine trusts Stripe's own exact email filter.
- **The grader is the weakest part.** Most "wrong" marks for both setups were facts that are in the articles or in our own rules. A person reads every failure before trusting a number.

## What it changes

- **Running cost:** `docs/ai-agent-plan.md` already assumed about $0.018 per conversation, and the engine measured $0.0067 a turn × 2.5 turns, about $0.017. Agent answers stay about $840 a month at Beta (50 teams) and $8,400 at Growth (500 teams).
- **Memory:** the brain drops from 2 GB to 512 MB. MongoDB and Qdrant are no longer needed.
- **Speed:** turns take 2.5 to 6 s instead of 10 to 19 s.
- **Playbooks** (phase 4) become rules and tools in the engine's prompt, checked by code before any action. Parlant journeys are no longer the plan.
- **The reply check** comes back in phase 2, as one Haiku pass after the reply instead of a rewrite loop.
- **The trial** stays as the engine's test set. Rerun `python -m trial.run_trial` after any change to the rules, prompt, search or tools.
