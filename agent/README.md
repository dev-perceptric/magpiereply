# Magpie AI agent service

The bridge between the MagpieReply app and the Magpie AI brain. Phase 0 of `docs/ai-agent-plan.md`; the step-by-step plan is in `docs/phase-0.md`.

```
Customer message → app → signed webhook → api: verify, save, queue
                                     → worker: read the conversation with the bot key → private note → run recorded
```

- `src/http.ts`: `GET /health` and `POST /hooks/chatwoot/:hookId`. Checks the team's hook address and the app's signature (`X-Chatwoot-Signature`, at most 5 minutes old), skips duplicates and anything that isn't a new customer message in a turned-on inbox, then queues a turn.
- `src/queue.ts`: pg-boss in the `pgboss` schema. One waiting and one running turn per conversation, so a burst of messages becomes one turn. 3 retries with growing waits.
- `src/jobs/turn.ts`: phase 0 turn. Reads the last 20 messages and posts a private note. Later phases add the brain.
- `src/db/migrations`: the `agent` schema, applied on deploy (`node dist/migrate.js`).
- `src/jobs/sync-knowledge.ts`: every 15 minutes, sends each team's published help center articles to the brain when they changed.
- `src/panel.ts`: the drafts side panel (a Dashboard App), with Send, Copy and Discard. `src/add-panel.ts` adds it to an account.
- `src/enable-team.ts`: connects an account. Creates the agent bot, attaches it to inboxes, and stores the bot key and signing secret encrypted.

## Run the tests

Needs Postgres. Uses `postgres://postgres:postgres@localhost:5432/magpie_agent_test` unless `TEST_DATABASE_URL` is set.

```bash
npm ci && npm test
```

## Deploy on the Hostinger VPS

The agent runs as `agent-api` and `agent-worker` in the VPS `magpiereply` project, at `agent.magpiereply.com` (`docs/hostinger.md`). A push builds `ghcr.io/dev-perceptric/magpie-agent`, and the server's `autodeploy` restarts both within 5 minutes. Both run the migrations when they start.

First-time setup, on the server:

1. Open the database shell with `docker exec -it sb-magpiereply-db-1 psql -U postgres` and create the agent's own login. It gets its own schemas and nothing in the app's `public` schema:

```sql
do $$
begin
  if not exists (select from pg_roles where rolname = 'magpie_agent') then
    create role magpie_agent login password '<strong-password>';
  end if;
end $$;

-- Supabase's postgres user isn't a superuser, so it must join the role before it can give it schemas.
grant magpie_agent to postgres;
create schema if not exists agent authorization magpie_agent;
create schema if not exists pgboss authorization magpie_agent;
grant create on database postgres to magpie_agent;
```

2. In `/docker/magpiereply/.env`, set `AGENT_DATABASE_URL` to that login on the `sb-magpiereply` database, and `AGENT_ENCRYPTION_KEY` to the output of `openssl rand -base64 32`.

3. Start it:

```bash
cd /docker/magpiereply && docker compose up -d agent-api agent-worker
```

4. Set `INTERNAL_API_KEY` (`openssl rand -hex 32`) on `agent-api` and `agent-worker`, and the same value as `MAGPIE_AGENT_KEY`, with `MAGPIE_AGENT_URL=http://agent-api:8080`, on `web` and `worker`. Teams then turn Magpie on from Settings → AI agent.

5. For websites and files, start the `magpie-reader` project (`docs/phase-1.md`) and set `READER_URL` and `READER_API_KEY` on `agent-worker`.

6. Or connect a team by hand (asks for an administrator API key from Profile settings → Access token):

```bash
cd /docker/magpiereply && docker compose exec agent-worker node dist/enable-team.js --account <id> --inboxes <id,id>
```

## Running cost

| Item | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| `agent-api` + `agent-worker`, 256 MB each on the VPS | $0 more (inside MagpieReply's server cost) | $0 more (on the KVM 8 for the brain, `docs/hostinger.md`) |
| Tables in `sb-magpiereply` | $0 | $0 |
| Claude | $0 in phase 0 | $0 in phase 0 |
