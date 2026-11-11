-- Magpie AI, phase 1: websites and files as knowledge, and drafts that carry their sources and fact check.

-- A website the team wants Magpie to read (crawled again each day) or a file it uploaded (read once).
create table agent.knowledge_sources (
  id bigserial primary key,
  team_id bigint not null references agent.teams (id) on delete cascade,
  kind text not null check (kind in ('website', 'file')),
  url text,
  file_name text,
  file_type text,
  -- The uploaded file, kept only until it has been read.
  file_data bytea,
  status text not null default 'reading' check (status in ('reading', 'ready', 'failed')),
  error text,
  pages integer not null default 0,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  check ((kind = 'website' and url is not null) or (kind = 'file' and file_name is not null))
);
create unique index knowledge_sources_website_idx on agent.knowledge_sources (team_id, url) where kind = 'website';
create index knowledge_sources_team_idx on agent.knowledge_sources (team_id, id);

-- What the reader found: one row per website page or one per file.
create table agent.knowledge_documents (
  id bigserial primary key,
  source_id bigint not null references agent.knowledge_sources (id) on delete cascade,
  url text,
  title text not null,
  body text not null
);
create index knowledge_documents_source_idx on agent.knowledge_documents (source_id, id);

alter table agent.drafts add column sources jsonb not null default '[]';
alter table agent.drafts add column fact_check jsonb;
alter table agent.drafts add column handoff_note text;
