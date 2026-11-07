# Magpie MCP gateway

[ContextForge](https://github.com/IBM/mcp-context-forge) v1.1.0 (Apache 2.0) on Fly as `magpie-gateway` in Tokyo. It holds each team's sign-ins to their apps and gives each team one MCP address, a virtual server, with only that team's tools. Part of `docs/ai-agent-plan.md`; phase 0 uses it for Stripe in the Parlant trial (`docs/phase-0.md`, Day 6).

```
agent or Parlant ──MCP──► magpie-gateway /servers/<team server>/mcp ──► mcp.stripe.com (Stripe sign-in, test mode)
```

- **Image:** the official `ghcr.io/ibm/mcp-context-forge:v1.1.0`, nothing added. Settings are in `fly.toml`.
- **Database:** its own `gateway` schema in the existing Supabase project, with its own login. It has no access to the app's or the agent's tables. It creates its 71 tables on first start.
- **Stripe sign-in:** Stripe's MCP server lets clients register themselves (public client, PKCE, scope `mcp`). The gateway does this on the first Authorize, so there's no Stripe app to set up. `DCR_ALLOWED_ISSUERS` only allows Stripe's sign-in server.
- **Sign-ins are per gateway user.** The Stripe sign-in belongs to the gateway user who clicked Authorize. Calls through the team's server use it only when they come with that user's API token.

## Deploy

1. In Supabase's SQL editor, create the gateway's own login and schema:

```sql
do $$
begin
  if not exists (select from pg_roles where rolname = 'magpie_gateway') then
    create role magpie_gateway login password '<strong-password>';
  end if;
end $$;

-- Supabase's postgres user isn't a superuser, so it must join the role before it can give it a schema.
grant magpie_gateway to postgres;
create schema if not exists gateway authorization magpie_gateway;
alter role magpie_gateway set search_path = gateway;
```

2. Create the app and set its secrets. Use the session pooler (port 5432) with the `magpie_gateway` login, and start the address with `postgresql+psycopg://`:

```bash
fly apps create magpie-gateway
```

```bash
fly secrets set --app magpie-gateway \
  DATABASE_URL='postgresql+psycopg://magpie_gateway.<project-ref>:<password>@<pooler-host>:5432/postgres' \
  JWT_SECRET_KEY="$(openssl rand -hex 32)" \
  AUTH_ENCRYPTION_SECRET="$(openssl rand -hex 32)" \
  PLATFORM_ADMIN_EMAIL='admin@magpiereply.com' \
  PLATFORM_ADMIN_PASSWORD='<at least 12 characters>' \
  DEFAULT_USER_PASSWORD='<at least 12 characters>' \
  BASIC_AUTH_PASSWORD='<at least 12 characters>'
```

3. Deploy from this folder:

```bash
fly deploy
```

`https://magpie-gateway.fly.dev/health` should answer `{"status":"healthy"}`.

## Connect Stripe for the trial

1. Sign in at `https://magpie-gateway.fly.dev/admin` with the admin email and password. Under **API Tokens**, create a token for the trial and keep it safe.
2. Add Stripe:

```bash
GATEWAY_TOKEN=<token> node gateway/trial.mjs add-stripe
```

3. In the admin, go to **Gateways**, click **Authorize** on `stripe`, sign in to Stripe, pick the **test-mode sandbox**, then click **Fetch tools**. Use the same admin user that made the token.
4. Make the test team's virtual server from Stripe's tools. It prints the MCP address:

```bash
GATEWAY_TOKEN=<token> node gateway/trial.mjs make-server
```

5. Check it, once the Stripe test customers exist (`agent/evals/trial/stripe-customers.json`). It lists the tools, then looks up Maya Alvarez and her payments, with the time each call takes:

```bash
GATEWAY_TOKEN=<token> node gateway/trial.mjs check
```

Tools reach the agent with the gateway's name in front, like `stripe-list-customers`.

## Tested

On a local copy of ContextForge 1.1.0 with Postgres: the schema and login setup above, `add-stripe` (run twice, it adds Stripe once), and `make-server` and `check` against a stand-in server with Stripe's tool names. The gateway added about 60 ms per tool call. The Stripe sign-in itself can only be tried once the gateway runs on Fly.

## Running cost

| Item | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| `magpie-gateway`, shared-cpu-1x 1 GB, always on (check) | ~$6 | ~$66 (more machines, later phases) |
| Supabase (a schema in the existing project) | $0 | $0 |
| Stripe test mode | $0 | $0 |
| Claude | $0 | $0 |
