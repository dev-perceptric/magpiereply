import type { Db } from './db.js';

export interface Team {
  id: number;
  accountId: number;
  name: string;
  mode: 'off' | 'draft' | 'auto';
  botId: number;
  botTokenEnc: string;
  botSecretEnc: string;
  monthlyCapUsd: number;
}

interface TeamRow {
  id: string;
  account_id: string;
  name: string;
  mode: Team['mode'];
  bot_id: string;
  bot_token_enc: string;
  bot_secret_enc: string;
  monthly_cap_usd: string;
}

function toTeam(row: TeamRow): Team {
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    name: row.name,
    mode: row.mode,
    botId: Number(row.bot_id),
    botTokenEnc: row.bot_token_enc,
    botSecretEnc: row.bot_secret_enc,
    monthlyCapUsd: Number(row.monthly_cap_usd),
  };
}

const TEAM_COLUMNS = 'id, account_id, name, mode, bot_id, bot_token_enc, bot_secret_enc, monthly_cap_usd';

export async function findTeamByHookHash(db: Db, hookIdHash: string): Promise<Team | null> {
  const result = await db.query<TeamRow>(`select ${TEAM_COLUMNS} from agent.teams where hook_id_hash = $1`, [hookIdHash]);
  return result.rows[0] ? toTeam(result.rows[0]) : null;
}

export async function findTeam(db: Db, teamId: number): Promise<Team | null> {
  const result = await db.query<TeamRow>(`select ${TEAM_COLUMNS} from agent.teams where id = $1`, [teamId]);
  return result.rows[0] ? toTeam(result.rows[0]) : null;
}

export async function upsertTeam(
  db: Db,
  team: { accountId: number; name: string; hookIdHash: string; botId: number; botTokenEnc: string; botSecretEnc: string },
): Promise<number> {
  const result = await db.query<{ id: string }>(
    `insert into agent.teams (account_id, name, hook_id_hash, bot_id, bot_token_enc, bot_secret_enc)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (account_id) do update set
       name = excluded.name, hook_id_hash = excluded.hook_id_hash, bot_id = excluded.bot_id,
       bot_token_enc = excluded.bot_token_enc, bot_secret_enc = excluded.bot_secret_enc, updated_at = now()
     returning id`,
    [team.accountId, team.name, team.hookIdHash, team.botId, team.botTokenEnc, team.botSecretEnc],
  );
  return Number(result.rows[0]!.id);
}

export async function enableInbox(db: Db, teamId: number, inboxId: number): Promise<void> {
  await db.query(
    `insert into agent.inbox_settings (team_id, inbox_id, enabled) values ($1, $2, true)
     on conflict (team_id, inbox_id) do update set enabled = true`,
    [teamId, inboxId],
  );
}

export async function isInboxEnabled(db: Db, teamId: number, inboxId: number): Promise<boolean> {
  const result = await db.query('select 1 from agent.inbox_settings where team_id = $1 and inbox_id = $2 and enabled', [
    teamId,
    inboxId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

// Returns false when this message was already received (a duplicate delivery).
export async function saveEvent(
  db: Db,
  event: { teamId: number; kind: string; messageId: number; conversationId: number; deliveryId?: string; payload: unknown },
): Promise<boolean> {
  const result = await db.query(
    `insert into agent.events (team_id, kind, message_id, conversation_id, delivery_id, payload)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (team_id, kind, message_id) do nothing`,
    [event.teamId, event.kind, event.messageId, event.conversationId, event.deliveryId ?? null, JSON.stringify(event.payload)],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function startRun(db: Db, run: { teamId: number; conversationId: number; jobId: string; attempt: number }): Promise<number> {
  const result = await db.query<{ id: string }>(
    'insert into agent.runs (team_id, conversation_id, job_id, attempt) values ($1, $2, $3, $4) returning id',
    [run.teamId, run.conversationId, run.jobId, run.attempt],
  );
  return Number(result.rows[0]!.id);
}

export async function recordStep(
  db: Db,
  step: { runId: number; name: string; input?: unknown; output?: unknown; durationMs: number; tokensIn?: number; tokensOut?: number },
): Promise<void> {
  await db.query(
    `insert into agent.run_steps (run_id, name, input, output, duration_ms, tokens_in, tokens_out)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      step.runId,
      step.name,
      step.input === undefined ? null : JSON.stringify(step.input),
      step.output === undefined ? null : JSON.stringify(step.output),
      step.durationMs,
      step.tokensIn ?? 0,
      step.tokensOut ?? 0,
    ],
  );
}

export async function finishRun(db: Db, runId: number, outcome: { status: 'done' | 'failed'; error?: string }): Promise<void> {
  await db.query('update agent.runs set status = $2, error = $3, finished_at = now() where id = $1', [
    runId,
    outcome.status,
    outcome.error ?? null,
  ]);
}

export interface ConversationState {
  lastMessageId: number;
  pendingNote: string | null;
  handedOff: boolean;
  // Auto mode: a reply saved before sending, so a retry sends it exactly once, and how often Magpie answered alone.
  pendingReply?: string | null;
  pendingReplyDraftId?: number | null;
  autoReplies?: number;
}

export async function getConversationState(db: Db, teamId: number, conversationId: number): Promise<ConversationState> {
  const result = await db.query<{
    last_message_id: string;
    pending_note: string | null;
    handed_off: boolean;
    pending_reply: string | null;
    pending_reply_draft_id: string | null;
    auto_replies: number;
  }>(
    `select last_message_id, pending_note, handed_off, pending_reply, pending_reply_draft_id, auto_replies
     from agent.conversations where team_id = $1 and conversation_id = $2`,
    [teamId, conversationId],
  );
  const row = result.rows[0];
  if (!row) return { lastMessageId: 0, pendingNote: null, handedOff: false, pendingReply: null, pendingReplyDraftId: null, autoReplies: 0 };
  return {
    lastMessageId: Number(row.last_message_id),
    pendingNote: row.pending_note,
    handedOff: row.handed_off,
    pendingReply: row.pending_reply,
    pendingReplyDraftId: row.pending_reply_draft_id === null ? null : Number(row.pending_reply_draft_id),
    autoReplies: row.auto_replies,
  };
}

export async function saveConversationState(db: Db, teamId: number, conversationId: number, state: ConversationState): Promise<void> {
  await db.query(
    `insert into agent.conversations
       (team_id, conversation_id, last_message_id, pending_note, handed_off, pending_reply, pending_reply_draft_id, auto_replies)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (team_id, conversation_id) do update set
       last_message_id = excluded.last_message_id,
       pending_note = excluded.pending_note, handed_off = excluded.handed_off,
       pending_reply = excluded.pending_reply, pending_reply_draft_id = excluded.pending_reply_draft_id,
       auto_replies = excluded.auto_replies, updated_at = now()`,
    [
      teamId,
      conversationId,
      state.lastMessageId,
      state.pendingNote,
      state.handedOff,
      state.pendingReply ?? null,
      state.pendingReplyDraftId ?? null,
      state.autoReplies ?? 0,
    ],
  );
}

export interface ActiveTeam {
  id: number;
  accountId: number;
  botTokenEnc: string;
  knowledgeHash: string | null;
}

// Teams the agent works for (mode draft or auto), for jobs that run across all of them.
export async function listActiveTeams(db: Db): Promise<ActiveTeam[]> {
  const result = await db.query<{ id: string; account_id: string; bot_token_enc: string; knowledge_hash: string | null }>(
    "select id, account_id, bot_token_enc, knowledge_hash from agent.teams where mode <> 'off' order by id",
  );
  return result.rows.map(row => ({
    id: Number(row.id),
    accountId: Number(row.account_id),
    botTokenEnc: row.bot_token_enc,
    knowledgeHash: row.knowledge_hash,
  }));
}

export async function saveKnowledgeHash(db: Db, teamId: number, hash: string): Promise<void> {
  await db.query('update agent.teams set knowledge_hash = $2, knowledge_synced_at = now() where id = $1', [teamId, hash]);
}

export async function setPanelKeyHash(db: Db, accountId: number, panelKeyHash: string): Promise<number | null> {
  const result = await db.query<{ id: string }>(
    'update agent.teams set panel_key_hash = $2, updated_at = now() where account_id = $1 returning id',
    [accountId, panelKeyHash],
  );
  return result.rows[0] ? Number(result.rows[0].id) : null;
}

export async function findTeamByPanelHash(db: Db, panelKeyHash: string): Promise<Team | null> {
  const result = await db.query<TeamRow>(`select ${TEAM_COLUMNS} from agent.teams where panel_key_hash = $1`, [panelKeyHash]);
  return result.rows[0] ? toTeam(result.rows[0]) : null;
}

export interface Draft {
  id: number;
  conversationId: number;
  reply: string | null;
  proposals: unknown[];
  handoff: { team: string; reason: string } | null;
  sources: Array<{ id: string; title: string; url: string | null }>;
  factCheck: { passed: boolean; unsupported: string[] } | null;
  handoffNote: string | null;
  guard: { flagged: boolean } | null;
  sentBy: 'person' | 'magpie' | null;
  status: 'pending' | 'sent' | 'discarded' | 'replaced';
  createdAt: string;
}

interface DraftRow {
  id: string;
  conversation_id: string;
  reply: string | null;
  proposals: unknown[];
  handoff: { team: string; reason: string } | null;
  sources: Draft['sources'];
  fact_check: Draft['factCheck'];
  handoff_note: string | null;
  guard: Draft['guard'];
  sent_by: Draft['sentBy'];
  status: Draft['status'];
  created_at: Date;
}

function toDraft(row: DraftRow): Draft {
  return {
    id: Number(row.id),
    conversationId: Number(row.conversation_id),
    reply: row.reply,
    proposals: row.proposals,
    handoff: row.handoff,
    sources: row.sources,
    factCheck: row.fact_check,
    handoffNote: row.handoff_note,
    guard: row.guard,
    sentBy: row.sent_by,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

// A new draft replaces any earlier one still waiting in the same conversation.
export async function saveDraft(
  db: Db,
  draft: {
    teamId: number;
    conversationId: number;
    runId: number;
    reply: string | null;
    proposals: unknown[];
    handoff: unknown;
    sources?: Draft['sources'];
    factCheck?: Draft['factCheck'];
    handoffNote?: string | null;
    guard?: { flagged: boolean } | null;
  },
): Promise<number> {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(
      "update agent.drafts set status = 'replaced', acted_at = now() where team_id = $1 and conversation_id = $2 and status = 'pending'",
      [draft.teamId, draft.conversationId],
    );
    const result = await client.query<{ id: string }>(
      `insert into agent.drafts (team_id, conversation_id, run_id, reply, proposals, handoff, sources, fact_check, handoff_note, guard)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [
        draft.teamId,
        draft.conversationId,
        draft.runId,
        draft.reply,
        JSON.stringify(draft.proposals),
        draft.handoff === null ? null : JSON.stringify(draft.handoff),
        JSON.stringify(draft.sources ?? []),
        draft.factCheck ? JSON.stringify(draft.factCheck) : null,
        draft.handoffNote ?? null,
        draft.guard ? JSON.stringify(draft.guard) : null,
      ],
    );
    await client.query('commit');
    return Number(result.rows[0]!.id);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

const DRAFT_COLUMNS = 'id, conversation_id, reply, proposals, handoff, sources, fact_check, handoff_note, guard, sent_by, status, created_at';

export async function latestDraft(db: Db, teamId: number, conversationId: number): Promise<Draft | null> {
  const result = await db.query<DraftRow>(
    `select ${DRAFT_COLUMNS} from agent.drafts where team_id = $1 and conversation_id = $2 order by id desc limit 1`,
    [teamId, conversationId],
  );
  return result.rows[0] ? toDraft(result.rows[0]) : null;
}

// Marks a waiting draft as sent or discarded. Returns null when it isn't this team's or isn't waiting any more,
// so a double click can never send the same draft twice.
export async function closeDraft(
  db: Db,
  draft: {
    teamId: number;
    draftId: number;
    status: 'sent' | 'discarded';
    sentContent?: string;
    actedBy: string;
    sentBy?: 'person' | 'magpie';
  },
): Promise<Draft | null> {
  const result = await db.query<DraftRow>(
    `update agent.drafts set status = $3, sent_content = $4, acted_by = $5, acted_at = now(),
       sent_by = case when $3 = 'sent' then $6 else null end
     where id = $2 and team_id = $1 and status = 'pending' returning ${DRAFT_COLUMNS}`,
    [draft.teamId, draft.draftId, draft.status, draft.sentContent ?? null, draft.actedBy, draft.sentBy ?? 'person'],
  );
  return result.rows[0] ? toDraft(result.rows[0]) : null;
}

export async function reopenDraft(db: Db, teamId: number, draftId: number): Promise<void> {
  await db.query(
    "update agent.drafts set status = 'pending', sent_content = null, acted_by = null, acted_at = null, sent_by = null where id = $2 and team_id = $1",
    [teamId, draftId],
  );
}

export interface AccountState {
  teamId: number;
  mode: Team['mode'];
  inboxIds: number[];
}

export async function getAccountState(db: Db, accountId: number): Promise<AccountState | null> {
  const team = await db.query<{ id: string; mode: Team['mode'] }>('select id, mode from agent.teams where account_id = $1', [accountId]);
  if (!team.rows[0]) return null;
  const inboxes = await db.query<{ inbox_id: string }>(
    'select inbox_id from agent.inbox_settings where team_id = $1 and enabled order by inbox_id',
    [team.rows[0].id],
  );
  return { teamId: Number(team.rows[0].id), mode: team.rows[0].mode, inboxIds: inboxes.rows.map(row => Number(row.inbox_id)) };
}

// Turns the agent on or off for an account and sets exactly which inboxes it works in.
export async function setAccountSettings(db: Db, teamId: number, settings: { mode: Team['mode']; inboxIds: number[] }): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query('update agent.teams set mode = $2, updated_at = now() where id = $1', [teamId, settings.mode]);
    await client.query('update agent.inbox_settings set enabled = false where team_id = $1 and not (inbox_id = any($2::bigint[]))', [
      teamId,
      settings.inboxIds,
    ]);
    for (const inboxId of settings.inboxIds) {
      await client.query(
        `insert into agent.inbox_settings (team_id, inbox_id, enabled) values ($1, $2, true)
         on conflict (team_id, inbox_id) do update set enabled = true`,
        [teamId, inboxId],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
