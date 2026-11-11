-- Magpie AI, phase 2: Auto mode, kill switches, spending caps, outcomes and replay tests.

-- What each turn cost, for the monthly cap and the Traces page.
alter table agent.runs add column cost_usd numeric(12, 5) not null default 0;
create index runs_team_month_idx on agent.runs (team_id, started_at);

-- Magpie stops calling Claude for a team once this month's spend reaches its cap.
alter table agent.teams add column monthly_cap_usd numeric(10, 2) not null default 50;

-- Who sent a draft (a person from the side panel, or Magpie itself in Auto mode) and the attack check.
alter table agent.drafts add column sent_by text check (sent_by in ('person', 'magpie'));
alter table agent.drafts add column guard jsonb;
update agent.drafts set sent_by = 'person' where status = 'sent';

-- Per conversation: a reply waiting to go out (so a retry sends it once), how many times Magpie answered on its
-- own, whether a person replied, and when it was resolved or reopened.
alter table agent.conversations add column pending_reply text;
alter table agent.conversations add column pending_reply_draft_id bigint;
alter table agent.conversations add column auto_replies integer not null default 0;
alter table agent.conversations add column person_replied boolean not null default false;
alter table agent.conversations add column resolved_at timestamptz;
alter table agent.conversations add column reopened integer not null default 0;
alter table agent.conversations add column created_at timestamptz not null default now();

-- Switches for every team at once: "auto_paused" turns Auto into Draft, "all_paused" stops Magpie.
create table agent.flags (
  name text primary key check (name in ('auto_paused', 'all_paused')),
  value boolean not null,
  updated_at timestamptz not null default now()
);

-- Replay tests: Magpie answers past conversations again and a small model compares each reply with the one a
-- teammate sent.
create table agent.eval_runs (
  id bigserial primary key,
  team_id bigint not null references agent.teams (id) on delete cascade,
  kind text not null default 'replay' check (kind in ('replay')),
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  cases integer not null default 0,
  passed integer not null default 0,
  cost_usd numeric(12, 5) not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index eval_runs_team_idx on agent.eval_runs (team_id, id desc);

create table agent.eval_cases (
  id bigserial primary key,
  eval_run_id bigint not null references agent.eval_runs (id) on delete cascade,
  conversation_id bigint not null,
  draft_id bigint,
  question text not null,
  reference text not null,
  candidate text,
  verdict text not null check (verdict in ('same', 'fine', 'wrong')),
  reason text
);
create index eval_cases_run_idx on agent.eval_cases (eval_run_id, id);
