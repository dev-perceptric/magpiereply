-- Magpie AI, phase 3: each team's own apps (Stripe, Linear, HubSpot, Shopify) over MCP, and email verification codes.

-- One OAuth client per app, registered once (dynamic client registration) or set from the app's own developer
-- dashboard, and shared by every team.
create table agent.oauth_clients (
  provider text primary key,
  client_id text not null,
  client_secret_enc text,
  redirect_uri text not null,
  created_at timestamptz not null default now()
);

-- A team's connection to one app. While it's being set up it holds the sign-in state; once connected, the keys.
create table agent.connections (
  id bigserial primary key,
  team_id bigint not null references agent.teams (id) on delete cascade,
  provider text not null,
  status text not null default 'pending' check (status in ('pending', 'connected', 'failed')),
  state_hash text unique,
  code_verifier_enc text,
  access_token_enc text,
  refresh_token_enc text,
  expires_at timestamptz,
  tool_count integer,
  error text,
  created_at timestamptz not null default now(),
  connected_at timestamptz,
  unique (team_id, provider)
);

-- Email verification: a 6-digit code sent to the address the customer gave, so Magpie can look up their account.
alter table agent.conversations add column verify_email text;
alter table agent.conversations add column verify_code_hash text;
alter table agent.conversations add column verify_expires_at timestamptz;
alter table agent.conversations add column verify_attempts integer not null default 0;
alter table agent.conversations add column verify_sent integer not null default 0;
alter table agent.conversations add column verified_email text;
alter table agent.drafts add column verification_email text;
