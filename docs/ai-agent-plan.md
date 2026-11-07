# MagpieReply AI agent: the full build plan

How every piece of the AI agent connects, what runs where, and the order to build it in. The agent answers customers from the team's own knowledge, follows the team's playbooks, uses the team's tools through MCP and hands off to a person when it should.

## 1. The pieces and where they run

| Piece | What it is | Runs on | License |
|---|---|---|---|
| **MagpieReply app** | The inbox (this repo, Rails) | Fly `magpiereply-web` + `magpiereply-worker`, Tokyo | MIT |
| **Agent service** | New TypeScript service in `agent/` of this repo: webhooks, thinking loop, playbook engine, job workers, admin pages | Fly `magpie-agent`, two process groups: `api` and `worker` | ours |
| **Mastra** | Agent framework and workflow engine inside the agent service | inside `magpie-agent` | Apache 2.0 (not its `ee/` code) |
| **MCP TypeScript SDK** | Talks to MCP servers | inside `magpie-agent` | MIT / Apache 2.0 |
| **Anthropic SDK** | Claude calls: Haiku 5.5 for sorting and checks, Sonnet 5.5 for answers and playbook steps | inside `magpie-agent` | MIT (check) |
| **pg-boss** | Job queue in Postgres: retries, delays, pauses for approvals and customer replies | inside `magpie-agent`, data in Supabase | MIT |
| **ContextForge** | MCP gateway: one front door to every team's tools, with per-team sign-ins, rate limits and logs | Fly `magpie-gateway` | Apache 2.0 |
| **Activepieces** (phase 5) | Ready-made connections for apps with no MCP server, exposed as MCP tools | Fly `magpie-connectors` | MIT (not its `ee/` code) |
| **Supabase Postgres** | One database: `public` schema for the app, `agent` schema for the agent, `pgboss` schema for jobs; `pgvector` for search | Supabase, Tokyo | managed |
| **Voyage** | Turns text into "meaning" vectors for search | API | paid service |
| **Langfuse** | Traces of every agent turn, costs, test datasets, AI-judge scores | Langfuse Cloud to start, self-hosted later | MIT (not its `ee/` code) |
| **promptfoo** | Golden-question tests and attack tests on every change | GitHub Actions | MIT |

Parlant (Apache 2.0) is the design reference for playbooks: guidelines matched to each moment of a chat, and journeys for step-by-step flows. We copy the design in TypeScript instead of running a Python service.

```
Customer ─► MagpieReply app (Rails) ──agent bot webhook──► magpie-agent (api)
                ▲                                              │ save event, queue job
                │ REST API (bot key): reply, note,             ▼
                │ handoff, assign, label                 pg-boss (Supabase) ──► magpie-agent (worker)
                └──────────────────────────────────────────────┤  Mastra: understand → playbook → tools → check → deliver
                                                               ├─► Claude (Haiku, Sonnet)
                                                               ├─► Supabase: agent schema + pgvector
                                                               ├─► Voyage (search vectors)
                                                               ├─► magpie-gateway (ContextForge) ─► each team's MCP servers
                                                               │                                    (Stripe, Shopify, Linear, HubSpot…)
                                                               │                                  ─► magpie-connectors (Activepieces)
                                                               └─► Langfuse (traces, scores)
```

## 2. How each connection works

### 2.1 App → agent (new messages)

- For each team that turns the agent on, the agent service creates an **agent bot** in that account through the app's API, with its webhook set to `https://magpie-agent.fly.dev/hooks/chatwoot/<team-hook-id>`. `<team-hook-id>` is a long random value per team, stored hashed, so the address itself acts as the password.
- The bot is attached to the inboxes the team picks (`POST /api/v1/accounts/:id/inboxes/:inbox_id/set_agent_bot`).
- The app sends events to that address. The agent uses `message_created` (new customer message), `message_updated` (a customer picked a button), `conversation_opened` and `conversation_resolved`.
- The webhook handler only checks the address, skips duplicates by message ID, saves the event and queues a job. It answers within a second.

### 2.2 Agent → app (replies and handoffs)

Uses the agent bot's API key. Today the app lets a bot key:

| Action | Endpoint |
|---|---|
| Send a reply or a private note | `POST .../conversations/:id/messages` (`private: true` for notes) |
| Hand off | `POST .../conversations/:id/toggle_status` with `open` |
| Assign a team or person | `POST .../conversations/:id/assignments` |
| Add labels | `POST .../conversations/:id/labels` |
| Set priority | `POST .../conversations/:id/toggle_priority` |
| Read the conversation | `GET .../conversations/:id` |

**App change needed (phase 0):** a bot key can't yet read the full message history, the contact or help center articles. Add these to `BOT_ACCESSIBLE_ENDPOINTS` in `app/controllers/concerns/access_token_auth_helper.rb`, read-only and limited to the bot's own account:

- messages list for a conversation
- contact show
- help center articles list and show

The change is small and sits outside code Chatwoot changes often, so upstream syncs stay easy.

**Customer confirmations** use the app's existing button messages (`content_type: input_select`). The customer's pick comes back as a `message_updated` event.

### 2.3 Staff screens

- **In the conversation:** a **dashboard app** (a free app feature) adds a side panel inside each conversation. It loads `https://magpie-agent.fly.dev/panel`. The app passes the conversation and the signed-in staff member to the panel. The panel shows:
  - the playbook in use
  - each step taken, with the trace
  - pending approvals, with Approve and Decline buttons
  - what the agent looked up
- **Settings:** `https://magpie-agent.fly.dev/admin` for knowledge sources, playbooks, tools, rules, tests and reports. Staff sign in with their MagpieReply email; the agent checks through the app's API that they're an admin of that account.
- **Later:** move settings into the app's own Settings screens (Vue), calling the agent's admin API.

### 2.4 Agent → tools (MCP)

- Each team gets a **virtual server** in ContextForge that bundles only that team's tools.
- **Connecting a tool:**
  1. The admin clicks **Connect Stripe** in `/admin`.
  2. ContextForge runs the sign-in (OAuth) and stores the token encrypted.
  3. The agent saves the tool's name, risk level and allowed playbooks in its own tables.
- **At runtime,** the agent connects to the team's virtual server with the MCP SDK (Streamable HTTP), using a short-lived gateway key that only works for that team.
- **The agent fills identity fields itself** (customer email, account ID) from the verified customer. The model never chooses them.
- **Tools with no MCP server** come from Activepieces, registered in ContextForge like any other server.
- **Teams' own APIs** are added as custom tools: the admin gives an address, inputs and a key, and ContextForge wraps them as MCP tools.

### 2.5 Agent → knowledge

- **Sources:**
  - help center articles, read through the app API
  - web pages (crawled)
  - PDFs (uploaded to Supabase Storage)
  - approved solved conversations
- **Sync:** every 15 minutes, plus a **Sync now** button. Later, the app sends an event when an article changes. That's a small change to the app's webhook events.
- **Pieces:** split by headings into pieces of about 300 to 800 words, each with its title, link and team ID. Voyage turns each piece into a vector, stored in `agent.knowledge_chunks` (`pgvector`) with a full-text index.
- **Search:** meaning search plus keyword search, a re-ranking pass, and the top 5 to 8 pieces, always filtered by team ID.

### 2.6 Database

All agent data lives in the `agent` schema, owned by a database role the app can't write to. The team's ID is the app's `account_id`.

| Table | Holds |
|---|---|
| `teams` | account ID, plan, mode (off, draft, auto), spending cap, hook ID (hashed), bot key (encrypted) |
| `inbox_settings` | per inbox: on or off, mode, business hours, handoff team |
| `knowledge_sources`, `knowledge_chunks` | sources and their searchable pieces (`vector(1024)`, full-text) |
| `playbooks`, `playbook_versions` | plain-English text and the structured steps, status (draft, testing, live) |
| `guidelines` | always-on rules: "when X, do Y" |
| `tools` | per team: MCP tool name, risk level (safe, customer confirms, staff approves), allowed playbooks |
| `runs` | one per conversation turn: playbook version, current step, waiting for (approval, customer, none) |
| `run_steps` | each step: inputs, tool result, decision, reason, tokens, time |
| `approvals` | action, amount, requested at, decided by, decided at |
| `memories` | short facts per customer |
| `outcomes` | per conversation: solved by agent, handed off (reason category), reopened, survey score |
| `eval_cases` | test conversations per team and playbook, with expected results |

Jobs live in the `pgboss` schema.

## 3. One customer message, through every piece

1. **App:** the customer writes, and the app marks the conversation pending (the bot has it) and calls the agent webhook.
2. **Agent API:** checks the hook ID, skips duplicates, saves the event and queues `turn` for this conversation, delayed 4 seconds so a burst of messages becomes one turn.
3. **pg-boss:** runs one `turn` job per conversation at a time (a singleton key per conversation).
4. **Worker, gather:** reads messages, contact and account through the app API; reads memories, rules and the team's tools from the `agent` schema.
5. **Understand (Haiku):** topic, language, mood, risk. Quick exits go to handoff: the customer asks for a person, is very upset, or the topic is on the "people only" list.
6. **Pick a playbook (Haiku):** match against each live playbook's `when` line and examples, plus any guidelines that apply right now.
7. **Run the playbook (Mastra workflow):**
   - Code steps (verify identity, ask, hand off) run in code.
   - Tool steps call MCP tools through the gateway, with identity fields filled by code.
   - Judgment steps ask Sonnet a narrow question about a tool result.
   - Reply steps ask Sonnet to write the message with the sources.
   - If a step needs approval or a customer answer, the run saves its state as **waiting** and the job ends. The approval or reply queues a `resume` job later.
   - With no playbook, the agent answers from knowledge search only, with no actions.
8. **Check (Haiku):** every claim is backed by a source or tool result, and no rule is broken. On failure, it rewrites once, then hands off.
9. **Deliver:** posts the reply, or a private note plus `toggle_status: open` and an assignment for a handoff. In draft mode, the reply goes into the panel for approval instead.
10. **Record:** run steps, tokens, time and cost to the `agent` tables and Langfuse.
11. **Later jobs:**
    - **Quiet sweep:** after N quiet minutes, Haiku judges whether to resolve or hand off.
    - **Outcome scoring:** when the conversation resolves or reopens, or a survey comes in.
    - **Learning:** suggested articles from handoffs with no source.

## 4. Playbooks (our AOPs)

- **Guidelines:** short always-on rules, like "When the customer mentions a chargeback, hand off to Billing." Before each turn, Haiku picks the ones that apply and adds only those to the prompt.
- **Journeys (playbooks):**
  1. The team writes in plain English.
  2. **Build steps** (Sonnet) turns it into structured steps.
  3. The team reviews them.
  4. The checker validates them: tools connected, safe inputs, approvals on money and identity, no dead ends.
  5. Each version becomes a Mastra workflow at load time.
- **State:** saved in `runs` after each step, so a run can pause for days and resume.
- **Going Live:** a playbook goes Live only when its tests pass.

## 5. Testing and monitoring

- **Before go-live (per team):**
  - replay the last few hundred real conversations
  - simulate customers built from past failures and handoffs
  - report solved, wrong and handed-off counts per playbook
- **On every change (CI):** promptfoo runs the golden questions and attack tests (prompt injection, trying to get refunds outside the rules). A drop in scores blocks the deploy.
- **Live:**
  - Langfuse traces every turn.
  - Haiku scores every conversation against the team's plain-language checks.
  - Alerts fire on error spikes, slow replies, handoff jumps and teams near their spending cap.
- **Kill switches:** per team, per inbox and one global switch, all in `/admin`.

## 6. Security

- **Team separation:** team ID on every row and every search; gateway keys scoped to one team; separate tool bundles per team.
- **Secrets:** bot keys and tool tokens encrypted at rest (tool tokens live in ContextForge). Nothing secret goes into prompts, traces or logs; card numbers and passwords are masked.
- **Prompt injection:** customer text, articles and tool results are passed as data. Actions are allowed only by playbook steps and risk levels, never by text.
- **Writes:** every write action has a unique key so a retry can't repeat it.
- **Database:** the agent role can read only what it needs from `public` and write only to `agent` and `pgboss`.

## 7. Code layout

```
agent/
  src/
    http/          webhook, panel, admin, health
    jobs/          turn, resume, sync-knowledge, sweep, score
    brain/         understand, pick-playbook, check, reply
    playbooks/     compiler (plain English → steps), checker, Mastra workflow builder
    tools/         MCP client to ContextForge, risk rules, identity filling
    knowledge/     crawl, split, embed, search
    chatwoot/      typed client for the app API
    db/            migrations for the agent schema
  evals/           promptfoo configs and golden questions
  Dockerfile
fly.agent.toml     magpie-agent (processes: api, worker)
fly.gateway.toml   magpie-gateway (ContextForge image)
```

Deploys go through GitHub Actions: lint, unit tests and promptfoo on every push; `flyctl deploy` for `magpie-agent` and `magpie-gateway` on the main branch.

## 8. Build order

| Phase | What ships | Done when |
|---|---|---|
| 0. Groundwork (1 week) | `agent/` service skeleton on Fly; `agent` schema; pg-boss; bot API access change in the app; agent bot setup per team; webhook to queue | A customer message in a test inbox shows up as a saved event and a queued job |
| 1. Answers from knowledge (2 weeks) | Help center sync, search, Sonnet answers with sources, grounding check, handoff note, draft mode in the panel | In draft mode, 70%+ of a test team's simple questions get correct, cited drafts |
| 2. Testing and auto mode (1 to 2 weeks) | Replay tests, golden questions in CI, Langfuse traces, outcome scoring, auto mode per inbox, kill switches | A team can see its replay report and turn on auto mode with confidence |
| 3. Tools, read-only (2 weeks) | ContextForge on Fly, per-team virtual servers, Connect buttons for Stripe and Shopify, identity filling, lookups in answers | "Where's my order?" and "What plan am I on?" are answered from live data |
| 4. Playbooks and actions (3 weeks) | Guidelines, playbook editor with Build steps, checker, Mastra workflows, pause and resume, approvals in the panel, customer confirm buttons | The duplicate-charge playbook runs end to end with a staff approval |
| 5. More connections and learning (2 weeks) | Activepieces connections, custom API tools, suggested articles, memories, quiet sweep, out-of-office on handoff | A team connects a tool with no MCP server, and suggested articles appear from handoffs |
| 6. Simulations and monitoring (2 weeks) | Simulated customers, per-conversation scoring with team checks, alerts | A playbook can only go Live after its simulations pass |

About 13 to 14 weeks for one engineer working with an AI assistant. Phases 0 to 2 (about 4 to 5 weeks) are enough for a first paying beta.

## 9. Running cost

Assumes 1,000 conversations per team each month. Claude and Voyage prices from `omniscient/scripts/cost-model.mjs` (checked October 2026); Fly and Upstash from their pricing pages (November 2026).

| Item | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Claude: answers, checks and sorting | ~$2,000 | ~$20,000 |
| Claude: tool lookups and actions | ~$450 | ~$4,500 |
| Claude: playbooks (picking, rule checks, tests) | ~$95 | ~$950 |
| Voyage search vectors | ~$0 (inside the free amount) | ~$150 |
| `magpie-agent` on Fly (api + worker) | ~$27 (2 × shared-cpu-2x) | ~$132 (2 × performance-2x) |
| `magpie-gateway` (ContextForge) | ~$13 | ~$66 |
| `magpie-connectors` (Activepieces, phase 5, check memory) | ~$13 | ~$66 |
| Langfuse (Cloud free tier at Beta, check; self-hosted at Growth) | ~$0 | ~$150 |
| Supabase (agent schema and vectors in the existing project, larger compute at Growth, check) | ~$0 | ~$60 |
| **Added monthly total** | **~$2,598** | **~$26,074** |

This is on top of the app itself (about $37 a month today; see `docs/fly.md`). Tokens are about 98% of the bill. The biggest savings:

- send easy questions to Haiku
- cache the fixed prompt
- cache answers to repeated questions
- run simulations only when something changes

## 10. Risks

| Risk | What we do |
|---|---|
| Wrong answers hurt trust | Draft mode first, the grounding check, the "Live only when tests pass" rule, and watching the wrong-answer rate above all else |
| ContextForge is early and IBM offers no official support | Keep our MCP client able to call servers directly; the gateway can be swapped |
| A team's tool changes or breaks | Tool errors hand off cleanly; gateway logs show which tool failed |
| Token costs grow faster than revenue | Per-team spending caps, plan-based limits, Haiku routing and caching |
| Upstream app changes break the bot API | The phase 0 app change is small and covered by tests; check it on every upstream sync |
