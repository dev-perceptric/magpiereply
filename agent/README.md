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
- `src/enable-team.ts`: connects an account. Creates the agent bot, attaches it to inboxes, and stores the bot key and signing secret encrypted.

## Run the tests

Needs Postgres. Uses `postgres://postgres:postgres@localhost:5432/magpie_agent_test` unless `TEST_DATABASE_URL` is set.

```bash
npm ci && npm test
```

## Deploy to Fly

1. In Supabase's SQL editor, create the agent's own database login. It gets its own schemas and nothing in the app's `public` schema:

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

2. Set the secrets (use the session pooler connection string with the `magpie_agent` login, port 5432):

```bash
fly secrets set --app magpie-agent DATABASE_URL='<connection string>' ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

3. Deploy from this folder:

```bash
fly deploy
```

4. Connect a team (asks for an administrator API key from Profile settings → Access token):

```bash
fly ssh console --app magpie-agent -C "node dist/enable-team.js --account <id> --inboxes <id,id>"
```

## Running cost

| Item | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| `api` + `worker`, shared-cpu-1x 1 GB each (check) | ~$13 | ~$132 (2 × performance-2x each, later phases) |
| Supabase (tables in the existing project) | $0 | $0 |
| Claude | $0 in phase 0 | $0 in phase 0 |
