# Magpie AI, phase 1: answers from the team's knowledge

Part of `docs/ai-agent-plan.md`. Phase 0 chose the brain (`docs/decisions/0001-brain.md`).

## Status

| Part | Status |
|---|---|
| Help center sync: every 15 minutes the worker reads each team's published articles (all live help centers, every page) and sends them to the brain, only when something changed | Built (`agent/src/jobs/sync-knowledge.ts`). The agent bot can now list help centers (read-only, `spec/requests/api/v1/accounts/agent_bot_read_access_spec.rb`) |
| Drafts side panel: a "Magpie" Dashboard App beside every conversation with the latest draft, Send (after editing), Copy and Discard | Built (`agent/src/panel.ts`). A draft is sent only on a teammate's click, at most once |
| Settings → AI agent: an administrator turns Magpie AI on, picks its inboxes and sees the mode (Draft now, Auto later). The first save makes the "Magpie AI" bot, connects it and adds the side panel | Built (`app/services/magpie/ai_agent.rb`, `agent/src/internal.ts`). Conversations Magpie files as pending move to Open once the draft is posted |
| Websites: a team adds up to 5 sites on Settings → AI agent → Knowledge. Crawl4AI reads up to 50 pages of each over plain HTTP (no browser), on the site's own domain, respecting robots.txt, and again every day | Built (`brain/magpie_reader/web.py`, `agent/src/jobs/read-source.ts`). Only public addresses are read, and the reader sits on its own network, so it can't reach anything inside the server |
| Files: up to 50 PDF, Word, PowerPoint, Excel, HTML, Markdown or text files of up to 20 MB, read once by Docling (no OCR, so scanned pages without text come back empty) | Built (`brain/magpie_reader/files.py`). One file at a time, in its own process, about 1.7 GB at most for a long PDF. The file is deleted once read; its text stays |
| Sourced replies: every draft lists the articles, pages and files it used, with links, in the side panel and the note | Built (`brain/magpie_brain/engine.py`) |
| Fact check: Haiku checks each draft against what Magpie read and lists anything it can't find, so the teammate checks before sending | Built. In Draft mode it only warns; Auto mode (phase 2) will hand off instead |
| Handoff notes: when Magpie suggests a handoff, Haiku writes two or three lines for the person taking over | Built |
| FlashRank re-ranking: hybrid search finds 12 candidates, FlashRank (MiniLM, on the CPU) picks the best 4 | Built (`brain/magpie_brain/knowledge.py`). A piece whose text didn't change keeps its vector, so a daily re-read costs almost nothing |
| MagpieReply on its own KVM 4 | Not now: the reader fits on the shared server while it reads one file at a time. Move when memory stays above 75% for a day (`docs/hostinger.md`) |

## Setting it up for a team

An administrator opens Settings → AI agent, turns Magpie AI on, ticks the inboxes and clicks Save. Nothing else is needed.

The page needs the app and the agent to share a key. On the server, set `INTERNAL_API_KEY` on `agent-api` and `agent-worker`, and `MAGPIE_AGENT_URL=http://agent-api:8080` plus `MAGPIE_AGENT_KEY` (the same key) on `web` and `worker`. Set `APP_PUBLIC_URL` (for example `https://app.magpiereply.com`) on `agent-api` and `agent-worker`, so article links and the panel's frame check use the public address. Without the key the page says Magpie AI isn't set up.

`enable-team` and `add-panel` still work from `agent-worker` for a team set up by hand.

Once Magpie is on, the same page shows Knowledge: the help center (automatic), websites and files, each with its state (Reading, the page count, or why it couldn't be read) and Read again and Remove buttons.

Websites and files need the reader: the `magpie-reader` project on the server, on its own `magpie-reader` network, which `agent-worker` joins. Set `READER_API_KEY` on the reader, and `READER_URL=http://reader:8810` plus the same `READER_API_KEY` on `agent-worker`. Without them, Magpie knows only the help center.

## Running cost

Prices for Claude and Voyage come from `omniscient/scripts/cost-model.mjs` (October 2026). Assumes 1,000 conversations per team each month with about 2.5 drafts each.

| Item | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Fact check and handoff notes: one Haiku call per draft, about 1,800 tokens in and 100 out ($0.00023) | ~$29 | ~$290 |
| Voyage for websites and files: read once, then only changed text (check) | ~$2 | ~$15 |
| Voyage for help center sync | under $1 | ~$5 |
| `magpie-reader` on the shared VPS: about 200 MB idle, 1.7 GB while reading a long PDF | $0 more | $0 more (on the brain's KVM 8) |
| FlashRank: on the brain's CPU, about 30 ms a draft | $0 | $0 |
| **Phase 1 adds** | **~$32** | **~$310** |

Draft replies on Sonnet stay as in the phase 0 figures (`docs/ai-agent-plan.md`). These totals sit inside the plan's ~$2,095 (Beta) and ~$20,795 (Growth) a month for everything.
