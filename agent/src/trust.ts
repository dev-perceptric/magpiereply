import type { Db } from './db.js';

// Phase 2: the switches, limits and numbers that decide when Magpie may answer on its own, and show how it did.

export type FlagName = 'auto_paused' | 'all_paused';

// Auto mode unlocks for a team after a replay test of at least this many past replies, with at least this share
// passing, in the last 30 days.
export const AUTO_MIN_CASES = 10;
export const AUTO_MIN_PASS_RATE = 0.9;
// After this many answers of its own in one conversation, a customer who still writes goes to a person.
export const MAX_AUTO_REPLIES = 2;

export async function getFlag(db: Db, name: FlagName): Promise<boolean> {
  const result = await db.query<{ value: boolean }>('select value from agent.flags where name = $1', [name]);
  return result.rows[0]?.value ?? false;
}

export async function setFlag(db: Db, name: FlagName, value: boolean): Promise<void> {
  await db.query(
    `insert into agent.flags (name, value) values ($1, $2)
     on conflict (name) do update set value = excluded.value, updated_at = now()`,
    [name, value],
  );
}

// This calendar month's spend (UTC): turns plus replay tests.
export async function monthSpend(db: Db, teamId: number): Promise<number> {
  const result = await db.query<{ total: string }>(
    `select coalesce((select sum(cost_usd) from agent.runs where team_id = $1 and started_at >= date_trunc('month', now())), 0)
          + coalesce((select sum(cost_usd) from agent.eval_runs where team_id = $1 and started_at >= date_trunc('month', now())), 0)
          as total`,
    [teamId],
  );
  return Number(result.rows[0]!.total);
}

export async function addRunCost(db: Db, runId: number, costUsd: number): Promise<void> {
  await db.query('update agent.runs set cost_usd = cost_usd + $2 where id = $1', [runId, costUsd]);
}

export async function setMonthlyCap(db: Db, teamId: number, capUsd: number): Promise<void> {
  await db.query('update agent.teams set monthly_cap_usd = $2, updated_at = now() where id = $1', [teamId, capUsd]);
}

export async function countAutoReply(db: Db, teamId: number, conversationId: number): Promise<void> {
  await db.query('update agent.conversations set auto_replies = auto_replies + 1 where team_id = $1 and conversation_id = $2', [
    teamId,
    conversationId,
  ]);
}

// What the app tells us about conversations Magpie worked on. Conversations it never touched are ignored.
export async function markPersonReplied(db: Db, teamId: number, conversationId: number): Promise<void> {
  await db.query('update agent.conversations set person_replied = true where team_id = $1 and conversation_id = $2', [
    teamId,
    conversationId,
  ]);
}

export async function markResolved(db: Db, teamId: number, conversationId: number): Promise<void> {
  await db.query('update agent.conversations set resolved_at = now() where team_id = $1 and conversation_id = $2 and resolved_at is null', [
    teamId,
    conversationId,
  ]);
}

export async function markReopened(db: Db, teamId: number, conversationId: number): Promise<void> {
  await db.query(
    `update agent.conversations set resolved_at = null, reopened = reopened + 1
     where team_id = $1 and conversation_id = $2 and resolved_at is not null`,
    [teamId, conversationId],
  );
}

export interface AutoGate {
  allowed: boolean;
  // Why not, in words for the settings page.
  reason: string | null;
}

export async function autoGate(db: Db, teamId: number): Promise<AutoGate> {
  const result = await db.query<{ cases: number; passed: number }>(
    `select cases, passed from agent.eval_runs
     where team_id = $1 and status = 'done' and started_at > now() - interval '30 days'
     order by id desc limit 1`,
    [teamId],
  );
  const latest = result.rows[0];
  if (!latest || latest.cases < AUTO_MIN_CASES) {
    return { allowed: false, reason: `Auto unlocks after a replay test of at least ${AUTO_MIN_CASES} replies your team sent.` };
  }
  if (latest.passed / latest.cases < AUTO_MIN_PASS_RATE) {
    return { allowed: false, reason: `The last replay test passed ${latest.passed} of ${latest.cases}. Auto needs ${AUTO_MIN_PASS_RATE * 100}%.` };
  }
  return { allowed: true, reason: null };
}

export interface Summary {
  month: { costUsd: number; capUsd: number; capReached: boolean };
  last30Days: {
    conversations: number;
    drafts: number;
    sentAsIs: number;
    sentEdited: number;
    discarded: number;
    autoSent: number;
    handedOff: number;
    resolved: number;
    solvedByMagpie: number;
    reopened: number;
    flaggedAttacks: number;
  };
}

export async function summaryFor(db: Db, teamId: number, capUsd: number): Promise<Summary> {
  const costUsd = await monthSpend(db, teamId);
  const drafts = await db.query<Record<string, string>>(
    `select
       count(*) as drafts,
       count(*) filter (where status = 'sent' and sent_by = 'person' and btrim(sent_content) = btrim(coalesce(reply, ''))) as sent_as_is,
       count(*) filter (where status = 'sent' and sent_by = 'person' and btrim(sent_content) <> btrim(coalesce(reply, ''))) as sent_edited,
       count(*) filter (where status = 'discarded') as discarded,
       count(*) filter (where status = 'sent' and sent_by = 'magpie') as auto_sent,
       count(*) filter (where (guard ->> 'flagged')::boolean) as flagged_attacks
     from agent.drafts where team_id = $1 and created_at > now() - interval '30 days'`,
    [teamId],
  );
  const conversations = await db.query<Record<string, string>>(
    `select
       count(*) as conversations,
       count(*) filter (where handed_off) as handed_off,
       count(*) filter (where resolved_at is not null) as resolved,
       count(*) filter (where resolved_at is not null and auto_replies > 0 and not person_replied and not handed_off) as solved_by_magpie,
       coalesce(sum(reopened), 0) as reopened
     from agent.conversations where team_id = $1 and created_at > now() - interval '30 days'`,
    [teamId],
  );
  const d = drafts.rows[0]!;
  const c = conversations.rows[0]!;
  return {
    month: { costUsd: Math.round(costUsd * 100) / 100, capUsd, capReached: costUsd >= capUsd },
    last30Days: {
      conversations: Number(c.conversations),
      drafts: Number(d.drafts),
      sentAsIs: Number(d.sent_as_is),
      sentEdited: Number(d.sent_edited),
      discarded: Number(d.discarded),
      autoSent: Number(d.auto_sent),
      handedOff: Number(c.handed_off),
      resolved: Number(c.resolved),
      solvedByMagpie: Number(c.solved_by_magpie),
      reopened: Number(c.reopened),
      flaggedAttacks: Number(d.flagged_attacks),
    },
  };
}

export interface RunRow {
  id: number;
  conversationId: number;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  durationMs: number | null;
  costUsd: number;
  error: string | null;
  // What came of the run: the draft's state, or why it was skipped.
  outcome: string | null;
}

// Newest first, 50 at a time; pass the last id seen as `before` for the next page.
export async function listRuns(db: Db, teamId: number, before?: number): Promise<RunRow[]> {
  const result = await db.query<{
    id: string;
    conversation_id: string;
    status: RunRow['status'];
    started_at: Date;
    finished_at: Date | null;
    cost_usd: string;
    error: string | null;
    draft_status: string | null;
    sent_by: string | null;
    skip_reason: string | null;
  }>(
    `select r.id, r.conversation_id, r.status, r.started_at, r.finished_at, r.cost_usd, r.error,
       d.status as draft_status, d.sent_by,
       (select s.output ->> 'reason' from agent.run_steps s where s.run_id = r.id and s.name = 'skip' limit 1) as skip_reason
     from agent.runs r
     left join agent.drafts d on d.run_id = r.id
     where r.team_id = $1 and ($2::bigint is null or r.id < $2)
     order by r.id desc limit 50`,
    [teamId, before ?? null],
  );
  return result.rows.map(row => ({
    id: Number(row.id),
    conversationId: Number(row.conversation_id),
    status: row.status,
    startedAt: row.started_at.toISOString(),
    durationMs: row.finished_at ? row.finished_at.getTime() - row.started_at.getTime() : null,
    costUsd: Number(row.cost_usd),
    error: row.error,
    outcome: row.draft_status ? (row.draft_status === 'sent' ? `sent_by_${row.sent_by ?? 'person'}` : row.draft_status) : row.skip_reason,
  }));
}

export interface RunStep {
  name: string;
  input: unknown;
  output: unknown;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  at: string;
}

export async function runSteps(db: Db, teamId: number, runId: number): Promise<{ run: RunRow; steps: RunStep[] } | null> {
  const [run] = (await listRuns(db, teamId, runId + 1)).filter(row => row.id === runId);
  if (!run) return null;
  const result = await db.query<{
    name: string;
    input: unknown;
    output: unknown;
    duration_ms: number;
    tokens_in: number;
    tokens_out: number;
    created_at: Date;
  }>('select name, input, output, duration_ms, tokens_in, tokens_out, created_at from agent.run_steps where run_id = $1 order by id', [runId]);
  return {
    run,
    steps: result.rows.map(row => ({
      name: row.name,
      input: row.input,
      output: row.output,
      durationMs: row.duration_ms,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      at: row.created_at.toISOString(),
    })),
  };
}
