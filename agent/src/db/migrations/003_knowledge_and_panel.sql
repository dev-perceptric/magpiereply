-- Magpie AI, phase 1: help center sync and the drafts side panel.

-- What was last sent to the brain, so an unchanged help center isn't sent (and paid for) again.
alter table agent.teams add column knowledge_hash text;
alter table agent.teams add column knowledge_synced_at timestamptz;
-- The side panel's address holds a long random key; only its hash is stored, like the webhook's.
alter table agent.teams add column panel_key_hash text unique;

-- Each draft the brain wrote, and what a teammate did with it in the side panel.
create table agent.drafts (
  id bigserial primary key,
  team_id bigint not null references agent.teams (id) on delete cascade,
  conversation_id bigint not null,
  run_id bigint references agent.runs (id) on delete set null,
  reply text,
  proposals jsonb not null default '[]',
  handoff jsonb,
  status text not null default 'pending' check (status in ('pending', 'sent', 'discarded', 'replaced')),
  sent_content text,
  acted_by text,
  created_at timestamptz not null default now(),
  acted_at timestamptz
);
create index drafts_conversation_idx on agent.drafts (team_id, conversation_id, id desc);
