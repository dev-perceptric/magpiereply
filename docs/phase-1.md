# Magpie AI, phase 1: answers from the team's knowledge

Part of `docs/ai-agent-plan.md`. Phase 0 chose the brain (`docs/decisions/0001-brain.md`).

## Status

| Part | Status |
|---|---|
| Help center sync: every 15 minutes the worker reads each team's published articles (all live help centers, every page) and sends them to the brain, only when something changed | Built (`agent/src/jobs/sync-knowledge.ts`). The agent bot can now list help centers (read-only, `spec/requests/api/v1/accounts/agent_bot_read_access_spec.rb`) |
| Drafts side panel: a "Magpie" Dashboard App beside every conversation with the latest draft, Send (after editing), Copy and Discard | Built (`agent/src/panel.ts`). A draft is sent only on a teammate's click, at most once |
| Websites (Crawl4AI) and files (Docling) | Next |
| FlashRank re-ranking, fact check, handoff summaries | Next |
| MagpieReply on its own KVM 4 | When Crawl4AI and Docling land |

## Setting it up for a team

After `enable-team`, in `agent-worker`, with an administrator API key in `APP_ADMIN_TOKEN`:

```bash
node dist/add-panel.js --account <id>
```

It adds the "Magpie" Dashboard App to the account. Set `APP_PUBLIC_URL` (for example `https://app.magpiereply.com`) on `agent-api` and `agent-worker`, so article links and the panel's frame check use the public address.

## Running cost

Help center sync re-reads articles only when they change: Voyage at $0.06 per million tokens is under $1 a month at Beta and about $5 at Growth (check). The panel and sync run on the existing agent containers. No change to Claude tokens from the phase 0 figures.
