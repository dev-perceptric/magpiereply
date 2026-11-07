-- Magpie AI, phase 0: teams, their inboxes, incoming events, and the runs that handle them.

create table agent.teams (
  id bigserial primary key,
  account_id bigint not null unique,
  name text not null,
  mode text not null default 'draft' check (mode in ('off', 'draft', 'auto')),
  hook_id_hash text not null unique,
  bot_id bigint not null,
  bot_token_enc text not null,
  bot_secret_enc text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table agent.inbox_settings (
  team_id bigint not null references agent.teams (id) on delete cascade,
  inbox_id bigint not null,
  enabled boolean not null default true,
  primary key (team_id, inbox_id)
);

-- Every webhook event we accept. The unique key skips duplicate deliveries of the same message.
create table agent.events (
  id bigserial primary key,
  team_id bigint not null references agent.teams (id) on delete cascade,
  kind text not null,
  message_id bigint not null,
  conversation_id bigint not null,
  delivery_id text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  unique (team_id, kind, message_id)
);
create index events_conversation_idx on agent.events (team_id, conversation_id, received_at desc);

-- One run per turn: the work done to answer a conversation after new customer messages.
create table agent.runs (
  id bigserial primary key,
  team_id bigint not null references agent.teams (id) on delete cascade,
  conversation_id bigint not null,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  job_id text,
  attempt int not null default 1,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index runs_conversation_idx on agent.runs (team_id, conversation_id, started_at desc);

-- Each step of a run: what went in, what came out, how long it took and what it cost.
create table agent.run_steps (
  id bigserial primary key,
  run_id bigint not null references agent.runs (id) on delete cascade,
  name text not null,
  input jsonb,
  output jsonb,
  duration_ms int not null,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  created_at timestamptz not null default now()
);
create index run_steps_run_idx on agent.run_steps (run_id, id);
