# Magpie AI, phase 1: answers from the team's knowledge

Part of `docs/ai-agent-plan.md`. Phase 0 chose the brain (`docs/decisions/0001-brain.md`).

## Status

| Part | Status |
|---|---|
| Help center sync: every 15 minutes the worker reads each team's published articles (all live help centers, every page) and sends them to the brain, only when something changed | Built (`agent/src/jobs/sync-knowledge.ts`). The agent bot can now list help centers (read-only, `spec/requests/api/v1/accounts/agent_bot_read_access_spec.rb`) |
| Drafts side panel: a "Magpie" Dashboard App beside every conversation with the latest draft, Send (after editing), Copy and Discard | Built (`agent/src/panel.ts`). A draft is sent only on a teammate's click, at most once |
| Settings → AI agent: an administrator turns Magpie AI on, picks its inboxes and sees the mode (Draft now, Auto later). The first save makes the "Magpie AI" bot, connects it and adds the side panel | Built (`app/services/magpie/ai_agent.rb`, `agent/src/internal.ts`). Conversations Magpie files as pending move to Open once the draft is posted |
| Websites (Crawl4AI) and files (Docling) | Next |
| FlashRank re-ranking, fact check, handoff summaries | Next |
| MagpieReply on its own KVM 4 | When Crawl4AI and Docling land |

## Setting it up for a team

An administrator opens Settings → AI agent, turns Magpie AI on, ticks the inboxes and clicks Save. Nothing else is needed.

The page needs the app and the agent to share a key. On the server, set `INTERNAL_API_KEY` on `agent-api` and `agent-worker`, and `MAGPIE_AGENT_URL=http://agent-api:8080` plus `MAGPIE_AGENT_KEY` (the same key) on `web` and `worker`. Set `APP_PUBLIC_URL` (for example `https://app.magpiereply.com`) on `agent-api` and `agent-worker`, so article links and the panel's frame check use the public address. Without the key the page says Magpie AI isn't set up.

`enable-team` and `add-panel` still work from `agent-worker` for a team set up by hand.

## Running cost

Help center sync re-reads articles only when they change: Voyage at $0.06 per million tokens is under $1 a month at Beta and about $5 at Growth (check). The panel, the sync and the settings page run on the existing containers. No change to Claude tokens from the phase 0 figures.
