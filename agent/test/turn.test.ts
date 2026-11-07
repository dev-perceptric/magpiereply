import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppClient, AppMessage } from '../src/chatwoot.js';
import type { Db } from '../src/db.js';
import { handleTurn } from '../src/jobs/turn.js';
import { createTestTeam, ENCRYPTION_KEY, freshDb } from './helpers.js';

let db: Db;

function fakeApp(options: { messages?: AppMessage[]; failNote?: boolean } = {}) {
  const calls = { tokens: [] as string[], notes: [] as Array<{ accountId: number; conversationId: number; content: string }> };
  const appClientFor = (token: string): AppClient => {
    calls.tokens.push(token);
    return {
      listMessages: async () =>
        options.messages ?? [
          { id: 1, content: 'Hi', message_type: 0, private: false, created_at: 1 },
          { id: 2, content: 'Looking into it', message_type: 1, private: false, created_at: 2 },
          { id: 3, content: 'I was charged twice', message_type: 0, private: false, created_at: 3 },
        ],
      createPrivateNote: async (accountId, conversationId, content) => {
        if (options.failNote) throw new Error('app unavailable');
        calls.notes.push({ accountId, conversationId, content });
      },
    };
  };
  return { appClientFor, calls };
}

beforeEach(async () => {
  db ??= await freshDb();
  await db.query('truncate agent.teams restart identity cascade');
});

afterAll(async () => {
  await db?.end();
});

describe('handleTurn', () => {
  it('reads the conversation with the bot key, posts a private note and records the run', async () => {
    const { teamId } = await createTestTeam(db, { accountId: 4 });
    const { appClientFor, calls } = fakeApp();

    await handleTurn({ db, encryptionKey: ENCRYPTION_KEY, appClientFor }, { id: 'job-1', data: { teamId, conversationId: 55 } });

    expect(calls.tokens).toEqual(['bot-api-key']);
    expect(calls.notes).toEqual([{ accountId: 4, conversationId: 55, content: 'Magpie received this (run #1).' }]);
    const run = (await db.query('select status, job_id, attempt from agent.runs')).rows[0];
    expect(run).toEqual({ status: 'done', job_id: 'job-1', attempt: 1 });
    const steps = (await db.query('select name, output from agent.run_steps order by id')).rows;
    expect(steps.map(step => step.name)).toEqual(['load_messages', 'post_note']);
    expect(steps[0].output).toEqual({ count: 3, lastCustomerMessageId: 3 });
  });

  it('marks the run failed and lets the queue retry when the app is down', async () => {
    const { teamId } = await createTestTeam(db);
    const { appClientFor } = fakeApp({ failNote: true });

    await expect(
      handleTurn({ db, encryptionKey: ENCRYPTION_KEY, appClientFor }, { id: 'job-2', data: { teamId, conversationId: 55 }, retryCount: 2 }),
    ).rejects.toThrow('app unavailable');

    const run = (await db.query('select status, error, attempt from agent.runs')).rows[0];
    expect(run).toEqual({ status: 'failed', error: 'app unavailable', attempt: 3 });
  });

  it('does nothing for a team that turned the agent off', async () => {
    const { teamId } = await createTestTeam(db);
    await db.query("update agent.teams set mode = 'off' where id = $1", [teamId]);
    const { appClientFor, calls } = fakeApp();

    await handleTurn({ db, encryptionKey: ENCRYPTION_KEY, appClientFor }, { id: 'job-3', data: { teamId, conversationId: 55 } });

    expect(calls.tokens).toHaveLength(0);
    expect((await db.query('select count(*)::int as n from agent.runs')).rows[0].n).toBe(0);
  });
});
