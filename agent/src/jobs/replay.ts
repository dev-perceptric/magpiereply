import type { AppClient } from '../chatwoot.js';
import type { BrainClient } from '../brain.js';
import { decrypt } from '../crypto.js';
import type { Db } from '../db.js';
import { findTeam } from '../repo.js';
import { customerOf, historyOf } from './turn.js';

// How many past replies one replay test reads again. About $0.006 each.
export const REPLAY_CASES = 30;

export interface ReplayDeps {
  db: Db;
  encryptionKey: string;
  appClientFor: (botToken: string) => AppClient;
  brain: BrainClient;
}

interface PastReply {
  draftId: number;
  conversationId: number;
  reference: string;
  // The newest customer message the original draft answered.
  cutoff: number;
}

// The replies teammates sent from the side panel, newest first, with the customer message each one answered.
async function pastReplies(db: Db, teamId: number): Promise<PastReply[]> {
  const result = await db.query<{ id: string; conversation_id: string; sent_content: string; cutoff: string | null }>(
    `select d.id, d.conversation_id, d.sent_content,
       (select max(value::bigint) from agent.run_steps s, jsonb_array_elements_text(s.input -> 'messageIds')
        where s.run_id = d.run_id and s.name = 'brain') as cutoff
     from agent.drafts d
     where d.team_id = $1 and d.status = 'sent' and d.sent_by = 'person' and btrim(coalesce(d.sent_content, '')) <> ''
     order by d.id desc limit $2`,
    [teamId, REPLAY_CASES],
  );
  return result.rows
    .filter(row => row.cutoff !== null)
    .map(row => ({ draftId: Number(row.id), conversationId: Number(row.conversation_id), reference: row.sent_content, cutoff: Number(row.cutoff) }));
}

export async function startReplay(db: Db, teamId: number): Promise<number> {
  const result = await db.query<{ id: string }>("insert into agent.eval_runs (team_id, kind) values ($1, 'replay') returning id", [teamId]);
  return Number(result.rows[0]!.id);
}

// Asks today's Magpie each past question again, as the customer saw the conversation then, and grades its answer
// against what the teammate sent. Nothing is sent or saved in the conversation.
export async function runReplay(deps: ReplayDeps, evalRunId: number): Promise<void> {
  const run = await deps.db.query<{ team_id: string }>('select team_id from agent.eval_runs where id = $1', [evalRunId]);
  const team = run.rows[0] ? await findTeam(deps.db, Number(run.rows[0].team_id)) : null;
  if (!team) return;

  try {
    const app = deps.appClientFor(decrypt(team.botTokenEnc, deps.encryptionKey));
    let cases = 0;
    let passed = 0;
    let cost = 0;
    for (const past of await pastReplies(deps.db, team.id)) {
      const messages = (await app.listMessages(team.accountId, past.conversationId, past.cutoff + 1)).filter(message => message.id <= past.cutoff);
      const history = historyOf(messages);
      if (history.length === 0) continue;
      const conversation = await app.getConversation(team.accountId, past.conversationId);
      const now = await deps.brain.runTurn({ team_id: String(team.id), customer: customerOf(conversation), history });
      const grade = await deps.brain.grade({ history, candidate: now.reply ?? '', reference: past.reference });
      cost += Number(now.cost_usd ?? 0) + Number(grade.cost_usd ?? 0);
      cases += 1;
      if (grade.verdict !== 'wrong') passed += 1;
      await deps.db.query(
        `insert into agent.eval_cases (eval_run_id, conversation_id, draft_id, question, reference, candidate, verdict, reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [evalRunId, past.conversationId, past.draftId, history[history.length - 1]!.content, past.reference, now.reply, grade.verdict, grade.reason],
      );
      await deps.db.query('update agent.eval_runs set cases = $2, passed = $3, cost_usd = $4 where id = $1', [evalRunId, cases, passed, cost]);
    }
    await deps.db.query("update agent.eval_runs set status = 'done', finished_at = now() where id = $1", [evalRunId]);
  } catch (error) {
    await deps.db.query("update agent.eval_runs set status = 'failed', error = $2, finished_at = now() where id = $1", [
      evalRunId,
      (error as Error).message.slice(0, 300),
    ]);
    throw error;
  }
}

export interface EvalRunRow {
  id: number;
  status: 'running' | 'done' | 'failed';
  cases: number;
  passed: number;
  costUsd: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export async function listEvalRuns(db: Db, teamId: number): Promise<EvalRunRow[]> {
  const result = await db.query<{
    id: string;
    status: EvalRunRow['status'];
    cases: number;
    passed: number;
    cost_usd: string;
    error: string | null;
    started_at: Date;
    finished_at: Date | null;
  }>('select id, status, cases, passed, cost_usd, error, started_at, finished_at from agent.eval_runs where team_id = $1 order by id desc limit 20', [
    teamId,
  ]);
  return result.rows.map(row => ({
    id: Number(row.id),
    status: row.status,
    cases: row.cases,
    passed: row.passed,
    costUsd: Number(row.cost_usd),
    error: row.error,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  }));
}

export async function evalCases(db: Db, teamId: number, evalRunId: number) {
  const result = await db.query<{
    conversation_id: string;
    question: string;
    reference: string;
    candidate: string | null;
    verdict: string;
    reason: string | null;
  }>(
    `select c.conversation_id, c.question, c.reference, c.candidate, c.verdict, c.reason
     from agent.eval_cases c join agent.eval_runs r on r.id = c.eval_run_id
     where r.id = $1 and r.team_id = $2 order by c.id`,
    [evalRunId, teamId],
  );
  return result.rows.map(row => ({
    conversationId: Number(row.conversation_id),
    question: row.question,
    reference: row.reference,
    candidate: row.candidate,
    verdict: row.verdict,
    reason: row.reason,
  }));
}
