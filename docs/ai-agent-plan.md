# Magpie AI: the full build plan

Magpie AI is MagpieReply's AI layer. It answers customers from the team's own knowledge, follows the team's playbooks, uses the team's apps through MCP, helps staff on the hard cases and proves its own quality. This plan covers every feature, how the pieces connect, the build order and the monthly cost.

## 1. What we're matching, and where we go further

| Area | Decagon (public info) | Chatwoot Captain (public page and code) | Magpie AI |
|---|---|---|---|
| Answers on its own | Yes | Yes, from help center, past chats and FAQs | Yes, with sources on every answer and a fact check before sending |
| Step-by-step procedures | AOPs: plain-language procedures | Not shown | Playbooks: plain English turned into checked steps, run by Parlant |
| Actions in other apps | Yes, with guardrails | Custom tools and MCP servers (paid) | 45+ apps through MCP, one-click Connect, risk levels and approvals |
| Handoff | Yes | Model-chosen handoff, failures, credit limits, quiet sweep | All of those, plus hard rules (upset, two failed tries, fact check fails) |
| Help for staff | Duet | Copilot: draft, improve, translate, ask about history | Copilot plus Investigate: root cause across Stripe, Sentry, GitHub and Slack |
| Fill knowledge gaps | Not shown | Smart FAQs | Suggested articles, plus flags for outdated or conflicting ones |
| Remember customers | Not shown | Memories | Memories, plus live account facts from the CRM |
| Test before going live | Simulations | Not shown | Replay tests, simulated customers, golden tests in CI, Live only when tests pass |
| Watch live quality | Watchtower | Monitors | Watch (scores every chat, AI and human) and Monitors (themes with alerts) |
| Sort and route | Not shown | Triage | Triage, plus outage detection that groups tickets and pages on-call |
| Languages | Yes | Auto-translate (paid) | Detect, answer in the customer's language, translate both ways for staff |
| Voice | Voice agents | Voice channel (paid) | Phase 9 |
| Open to other agents | Not shown | Not shown | MagpieReply's own MCP server, so a customer's AI tools can read their support data |

## 2. The pieces and where they run

| Piece | Role | Runs on | License |
|---|---|---|---|
| MagpieReply app | The inbox: channels, conversations, help center | Fly `magpiereply-web` + `magpiereply-worker` | MIT |
| **magpie-agent** (TypeScript, `agent/` in this repo) | The bridge: webhook, job queue, app client, approvals panel, admin, MCP client, traces | Fly, processes `api` + `worker` | ours |
| **magpie-brain** (Python) | The thinking brain: Parlant, plus Docling, Crawl4AI, FlashRank, Presidio, LLM Guard, Lingua | Fly | Apache 2.0 / MIT |
| **magpie-gateway** | ContextForge MCP gateway: each team's private bundle of app tools and sign-ins | Fly | Apache 2.0 |
| Supabase Postgres | App tables (`public`), agent tables (`agent`), jobs (`pgboss`), search (`pgvector`) | Supabase, Tokyo | managed |
| MongoDB + Qdrant | Parlant's storage and its knowledge search | Atlas (check) + Fly | managed / Apache 2.0 |
| Claude | Haiku 5.5 for sorting, matching and checks; Sonnet 5.5 for replies; Opus for investigations | API | paid |
| Voyage | Meaning vectors for search | API | paid |
| promptfoo, Ragas, DeepEval | Tests and quality scores in CI | GitHub Actions | MIT / Apache 2.0 |
| OpenTelemetry, Uptime Kuma | Traces across services, uptime and status page | inside services / Fly | Apache 2.0 / MIT |

```
Customer ─► MagpieReply app ──webhook──► magpie-agent (bridge) ──► magpie-brain (Parlant + Python tools) ──► Claude
                 ▲                          │   ▲                         │
                 └── reply / note / handoff ┘   └──── tool calls ─────────┘
                                            │
                                            ├─► magpie-gateway (ContextForge) ─► Stripe, Shopify, HubSpot, Linear, Slack… (MCP)
                                            ├─► Supabase: agent tables, pg-boss jobs, pgvector, traces
                                            └─► /admin, side panel, reports
```

The bridge owns everything specific to MagpieReply. The brain owns deciding what to say and do. The gateway owns the keys to each team's apps. If the Parlant trial fails, the brain becomes a TypeScript engine (Mastra workflows) inside the bridge; the rest of the plan stays the same.

## 3. Every feature

### A. Magpie Agent: answers customers

1. **Answers from knowledge, with sources.** Help center, websites (Crawl4AI), PDFs and docs (Docling), and approved solved chats. Hybrid search (meaning plus keywords), re-ranked by FlashRank.
2. **Playbooks.** The team writes how to handle a case in plain English. Sonnet turns it into steps, the checker validates them (tools connected, safe inputs, approvals on money and identity, no dead ends) and Parlant runs them as journeys. Versions, and Draft, Testing or Live status.
3. **Rules.** "When X, do Y" policies (Parlant guidelines), applied only when they fit the moment.
4. **Approved wording.** Fixed replies for sensitive moments, like refunds, legal or outages.
5. **Actions in the team's apps.** Through MCP, with three risk levels:
   - safe (runs on its own)
   - customer confirms (buttons in the chat)
   - staff approves (card in the side panel)
   
   Also: amount limits, daily caps, unique keys so a retry can't run twice, and a log on the conversation.
6. **Identity first.** Lookups and actions only for a verified customer: widget identity check, email sender, or a one-time code sent by email before sensitive actions. Identity fields are filled by code, never by the model.
7. **Smart handoff.**
   - **When:** the customer asks, missing knowledge, a request it isn't set up for, a policy limit, the customer is upset, two failed tries, the fact check fails, an error, or the spending cap is reached.
   - **How:** a private summary note, the right team assigned, the customer told, and an out-of-office message after hours.
8. **Quiet sweep.** After N quiet minutes, Haiku decides whether to resolve the conversation or hand it off, with a note.
9. **Languages.** Lingua detects the language for free, the agent answers in it, and staff see both ways translated.
10. **Channel-aware replies.** Short for chat, formatted for email, within WhatsApp's 24-hour window, plain for SMS.
11. **Modes and switches.** Draft or Auto per inbox, business hours, and kill switches per inbox, per team and globally.
12. **Memories.** Short facts per customer ("prefers email"), plus live account facts from the CRM.
13. **Closing the loop.** Messages customers when their Linear or Jira bug is fixed, reopens if it's still broken, and follows up on promised callbacks.

### B. Magpie Copilot: helps staff

14. **Draft, improve, change tone, translate,** inside the reply box (moved from OpenAI to Claude).
15. **Ask Copilot.** Questions in plain English about a customer, across past conversations and connected apps: "Did we discuss enterprise pricing with them?"
16. **Investigate.** For hard tickets: checks recent deploys (GitHub, Vercel), errors (Sentry), on-call chat (Slack) and similar tickets, then writes a root cause with links. Uses Opus.
17. **Summaries.** One-click thread summary, and the handoff note.
18. **Suggested next step.** Recommends a macro, a playbook or a team to route to.

### C. Knowledge that improves itself

19. **Suggested articles.** Questions with no good answer become draft articles for a person to approve.
20. **Knowledge health.** Flags articles that are outdated, contradict each other or lead to handoffs.
21. **Learns the team's style** from staff edits to drafts.

### D. Quality and safety

22. **Replay tests.** Runs the team's past conversations before go-live: solved, wrong and handed-off counts per playbook.
23. **Simulated customers.** Built from the team's real failures: angry, vague, or trying for a refund they shouldn't get.
24. **Golden tests in CI** (promptfoo, DeepEval). A playbook goes Live only when its tests pass, and every change reruns them.
25. **Answer-quality scores** (Ragas): did search find the right pieces, and did the answer stick to them?
26. **Watch.** Scores every conversation, AI and human, against checks the team writes in plain language.
27. **Monitors.** Tracks themes in plain English ("customers mentioning a competitor") with counts and alerts.
28. **Guardrails:**
    - a fact check before sending
    - a rule check on every reply and action
    - LLM Guard for prompt injection
    - Presidio to mask personal data in logs and traces
29. **Explain any reply.** Every step, rule, tool call, token and second, in the side panel and on the Traces page.
30. **Spending caps** per team and plan, with alerts before the limit.

### E. Triage and routing

31. **Auto-sort.** Topic labels, priority, mood, spam, and routing to the right team, on every new conversation.
32. **Outage detection.** Groups a burst of similar tickets into one incident card, pages on-call (PagerDuty MCP, staff approves), sends one holding reply to everyone and the all-clear when it's fixed.

### F. Connections

33. **One-click apps over MCP:**
    - **Payments:** Stripe, PayPal, Square, Chargebee, Paddle
    - **Stores:** Shopify, Recharge, ShipStation
    - **CRM:** HubSpot, Attio, Pipedrive, Salesloft, Close, Gong
    - **Engineering:** GitHub, GitLab, Linear, Jira, Confluence, Sentry, Datadog, PagerDuty, Vercel, Cloudflare, Supabase
    - **Team:** Slack, Notion, Asana, monday.com, ClickUp, Airtable, Box
    - **Other:** PostHog, Amplitude, Klaviyo, Customer.io, Postscript, Intercom, Gorgias, Cal.com, Calendly, DocuSign
34. **Custom tools.** Any in-house API becomes an MCP tool (check ContextForge's REST-to-MCP feature).
35. **Omniscient connection.** An Omniscient MCP server (ours to build) for account context, deals and contracts.
36. **MagpieReply MCP server.** A customer's own AI tools (Claude, ChatGPT, Cursor) can read their tickets, customer overviews and bug reports.

### G. Insights

37. **Agent reports:**
    - share solved by the agent
    - wrong-answer rate
    - handoff reasons
    - satisfaction
    - cost per conversation
    - results per playbook
38. **Topic trends.** What customers ask about, rising and falling.
39. **Revenue signals.** Upsell requests and churn risk sent to the CRM (Omniscient or HubSpot).

### H. Voice (phase 9)

40. **Phone agent.** Twilio number, live speech-to-text (faster-whisper or Deepgram), the same brain and playbooks, text-to-speech, handoff to a person, and a recording and summary on the conversation.

## 4. One customer message, through every piece

1. **App:** creates or updates the conversation, marks it pending and calls the bridge webhook.
2. **Bridge:** checks the address, skips duplicates, saves the event and queues a turn after a 4-second wait, one job per conversation at a time.
3. **Bridge:** gathers messages, contact, verified identity, memories, team rules and tool list.
4. **Brain:** Lingua detects the language, LLM Guard scans for attacks and Haiku sorts topic, mood and risk. Quick exits go to handoff.
5. **Brain:** Parlant matches the journey step, rules and approved wording that apply.
6. **Brain:** searches knowledge; FlashRank keeps the best 3 to 5 pieces.
7. **Bridge to gateway:** runs the tool calls the matched step allows, through the team's MCP bundle, with identity filled by code.
8. **Brain:** Sonnet writes the reply. Parlant reviews the reply and any action against the rules, and the fact check confirms each claim has a source.
9. **Bridge:** replies, pauses for a confirm or approval (saving the run, resuming later with a unique key), or hands off with a note.
10. **Bridge:** saves the trace (Presidio-masked), tokens, time and cost.
11. **Later jobs:** quiet sweep, outcome scoring, Watch, Monitors, suggested articles and closing the loop.

## 5. Data (`agent` schema)

| Table | Holds |
|---|---|
| `teams`, `inbox_settings` | mode, caps, hook ID (hashed), bot key (encrypted), hours, handoff team |
| `knowledge_sources`, `knowledge_chunks` | sources and searchable pieces (`vector`, full-text) |
| `playbooks`, `playbook_versions`, `guidelines`, `approved_replies` | the team's procedures and rules, synced to Parlant |
| `tools` | MCP tool name, risk level, limits, allowed playbooks |
| `runs`, `run_steps`, `approvals` | each turn, each step, waiting state and approvals |
| `memories`, `outcomes` | customer facts; solved, handed off (reason), reopened, survey score |
| `eval_cases`, `eval_runs` | replay, simulated and golden tests with results |
| `watch_checks`, `watch_scores`, `monitors`, `monitor_hits` | quality checks and theme tracking |
| `incidents` | grouped tickets during an outage |

## 6. Build order

| Phase | What ships | Weeks |
|---|---|---|
| 0. Groundwork | Bridge on Fly, agent schema, pg-boss, bot API access in the app, webhook to queue, Parlant trial (one journey, Stripe through the gateway) | 1 to 2 |
| 1. Answers | Knowledge sync (help center, Crawl4AI, Docling), search with FlashRank, sourced replies, fact check, handoff notes, Draft mode, side panel | 2 |
| 2. Trust | Replay tests, golden tests in CI, Ragas, Traces page, outcome scoring, Auto mode, kill switches, spending caps, Presidio, LLM Guard | 2 |
| 3. Apps, read-only | Gateway on Fly, per-team bundles, one-click Stripe, Shopify, HubSpot and Linear, identity filling, verification codes | 2 |
| 4. Playbooks and actions | Playbook editor, checker, journeys and rules in Parlant, approved wording, confirm buttons, approvals, pause and resume | 3 |
| 5. Copilot | Draft, improve and translate on Claude, Ask Copilot, summaries, suggested next step, Investigate | 2 |
| 6. Learning and triage | Suggested articles, knowledge health, style learning, memories, quiet sweep, auto-sort, out-of-office | 2 |
| 7. Watch and simulations | Simulated customers, Watch scoring, Monitors, alerts, outage detection | 2 |
| 8. Connections and insights | The rest of the MCP list, custom tools, Omniscient MCP, MagpieReply MCP server, reports, topic trends, revenue signals, closing the loop | 3 |
| 9. Voice | Phone agent on Twilio | 3 |

About 22 to 23 weeks to phase 8, plus 3 for voice, for one engineer working with an AI assistant. **Phases 0 to 3 (about 7 to 8 weeks) are enough for a paid beta.**

## 7. Running cost

Assumes 1,000 customer conversations per team each month, 5 staff per team using Copilot about 10 times a working day, and investigations on 10% of conversations. Claude and Voyage prices from `omniscient/scripts/cost-model.mjs` (October 2026); Fly, Upstash and Render from their pricing pages (November 2026). Tokens assume the savings in section 8; the worst case is about 2.5 times higher.

| Item | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Agent answers and actions (about $0.018 per conversation) | ~$900 | ~$9,000 |
| Copilot (about $0.008 per use) | ~$440 | ~$4,400 |
| Investigate (Opus, 10% of conversations) | ~$375 | ~$3,750 |
| Simulations (run on each change) | ~$200 | ~$2,000 |
| Watch scoring every conversation (Haiku) | ~$50 | ~$500 |
| Auto-sort, Monitors, quiet sweep, translations (Haiku) | ~$60 | ~$600 |
| Ragas and DeepEval scoring in CI | ~$20 | ~$200 |
| **Claude subtotal** | **~$2,045** | **~$20,450** |
| `magpie-agent` (bridge) | ~$27 | ~$132 |
| `magpie-brain` (Parlant + Python tools) | ~$26 | ~$132 |
| `magpie-gateway` (ContextForge) | ~$13 | ~$66 |
| MongoDB for Parlant (Atlas, check) | ~$57 | ~$200 |
| Qdrant on Fly (check) | ~$13 | ~$66 |
| Voyage vectors | ~$0 (free amount) | ~$150 |
| Supabase compute for agent tables (check) | ~$0 | ~$60 |
| Uptime Kuma, PostHog (free tier, check) | ~$2 | ~$52 |
| **Infrastructure subtotal** | **~$138** | **~$858** |
| **Magpie AI total** | **~$2,183** | **~$21,308** |
| MagpieReply app itself (`docs/fly.md`) | ~$37 | ~$409 |
| **Everything** | **~$2,220** | **~$21,717** |

That's about $44 per team per month at Beta and $43 at Growth. Voice (phase 9) is extra and usage-based: about $15 to $25 per team for 1,000 call minutes (Twilio and transcription, check).

## 8. Keeping tokens down

- **Haiku for easy turns.** Simple questions ("where's my order") skip Sonnet.
- **Prompt caching** for rules, playbooks and tool lists, which are reread at a 90% discount.
- **FlashRank** so each answer reads 3 to 5 pieces instead of 8.
- **Lingua** instead of a model call for language.
- **Answer cache** for repeated questions.
- **Simulations only when something changes.**
- **Per-team caps,** so no team can run up the bill.

## 9. Risks

| Risk | What we do |
|---|---|
| Wrong answers hurt trust | Draft mode first, fact check, Live only when tests pass, Watch on every chat; wrong-answer rate is the number we watch hardest |
| Parlant doesn't fit (MCP connection, token use) | Decided in the phase 0 trial; fallback is our own Mastra engine in the bridge |
| ContextForge is early and IBM offers no official support | Our MCP client can call servers directly; the gateway can be swapped |
| A team's app changes or breaks | Tool errors hand off cleanly; gateway logs show which tool failed |
| Token costs outrun revenue | Caps per plan, Haiku routing, caching, and pricing at least 3 times cost per team |
| Upstream app changes break the bot API | The app change is small and tested; checked on every upstream sync |
| Personal data in prompts and logs | Presidio masking, identity-locked lookups, encrypted tokens, team separation on every row |
