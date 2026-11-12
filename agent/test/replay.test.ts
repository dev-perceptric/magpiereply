import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppClient, AppMessage } from '../src/chatwoot.js';
import type { BrainClient } from '../src/brain.js';
import type { Db } from '../src/db.js';
import { evalCases, listEvalRuns, runReplay, startReplay } from '../src/jobs/replay.js';
import { createTestTeam, ENCRYPTION_KEY, freshDb } from './helpers.js';

let db: Db;

beforeEach(async () => {
  db ??= await freshDb();
  await db.query('truncate agent.teams restart identity cascade');
});

afterAll(async () => {
  await db?.end();
});

async function sentDraft(teamId: number, conversationId: number, cutoff: number, sent: string) {
  const run = (await db.query("insert into agent.runs (team_id, conversation_id, status) values ($1, $2, 'done') returning id", [teamId, conversationId])).rows[0].id;
  await db.query("insert into agent.run_steps (run_id, name, input, duration_ms) values ($1, 'brain', $2, 1)", [run, JSON.stringify({ messageIds: [cutoff] })]);
  await db.query("insert into agent.drafts (team_id, conversation_id, run_id, reply, status, sent_content, sent_by) values ($1, $2, $3, 'x', 'sent', $4, 'person')", [
    teamId,
    conversationId,
    run,
    sent,
  ]);
}

describe('replay tests', () => {
  it('asks again as of the original question and grades against what the teammate sent', async () => {
    const { teamId } = await createTestTeam(db);
    await sentDraft(teamId, 55, 3, 'Refunds take 5 to 10 business days.');
    await sentDraft(teamId, 56, 8, 'We ship to Canada.');
    const asked: Array<{ conversationId: number; before?: number }> = [];
    const messages: Record<number, AppMessage[]> = {
      55: [{ id: 3, content: 'When is my refund back?', message_type: 0, private: false, created_at: 3 }],
      56: [
        { id: 8, content: 'Do you ship to Canada?', message_type: 0, private: false, created_at: 8 },
        { id: 9, content: 'Thanks!', message_type: 0, private: false, created_at: 9 },
      ],
    };
    const app: AppClient = {
      getConversation: async conversationId => ({ id: conversationId, meta: {} }),
      listMessages: async (_account, conversationId, before) => {
        asked.push({ conversationId, before });
        return messages[conversationId]!;
      },
      createPrivateNote: async () => {
        throw new Error('replay never writes to a conversation');
      },
      openConversation: async () => undefined,
      sendReply: async () => {
        throw new Error('replay never sends');
      },
      sendVerificationEmail: async () => undefined,
      listPortals: async () => [],
      listPublishedArticles: async () => [],
    };
    const histories: string[][] = [];
    const brain: BrainClient = {
      runTurn: async request => {
        histories.push(request.history.map(message => message.content));
        return { reply: 'In 2 days.', sources: [], check: null, handoff_note: null, tools: [], proposals: [], handoff: null, seconds: 1, cost_usd: '0.004', tokens: {} };
      },
      grade: async request => ({ verdict: request.reference.includes('5 to 10') ? 'wrong' : 'fine', reason: 'compared', cost_usd: '0.001' }),
      putKnowledge: async () => ({ articles: 0, pieces: 0 }),
    };

    const evalRunId = await startReplay(db, teamId);
    await runReplay({ db, encryptionKey: ENCRYPTION_KEY, appClientFor: () => app, brain }, evalRunId);

    expect(asked).toEqual([
      { conversationId: 56, before: 9 },
      { conversationId: 55, before: 4 },
    ]);
    expect(histories).toEqual([['Do you ship to Canada?'], ['When is my refund back?']]);
    const [run] = await listEvalRuns(db, teamId);
    expect(run).toMatchObject({ status: 'done', cases: 2, passed: 1, costUsd: 0.01 });
    expect((await evalCases(db, teamId, evalRunId)).map(row => row.verdict)).toEqual(['fine', 'wrong']);
  });
});
