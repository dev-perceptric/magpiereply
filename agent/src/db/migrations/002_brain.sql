-- Magpie AI, phase 0 week 2: where each conversation stands with the brain.
create table agent.conversations (
  team_id bigint not null references agent.teams (id) on delete cascade,
  conversation_id bigint not null,
  -- The newest customer message already sent to the brain, so a retry never sends one twice.
  last_message_id bigint not null default 0,
  -- A draft saved before posting, so a failed post is retried without asking the brain again.
  pending_note text,
  handed_off boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (team_id, conversation_id)
);
