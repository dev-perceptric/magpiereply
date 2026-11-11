import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { createHttpApp } from '../src/http.js';
import { createTestTeam, customerMessageEvent, ENCRYPTION_KEY, freshDb, signedHeaders } from './helpers.js';

let db: Db;
let queued: Array<{ teamId: number; conversationId: number }>;
let queueAccepts: boolean;

function app() {
  return createHttpApp({
    db,
    encryptionKey: ENCRYPTION_KEY,
    enqueueTurn: async job => {
      queued.push(job);
      return queueAccepts;
    },
    healthCheck: async () => {
      await db.query('select 1');
    },
  });
}

async function post(hookId: string, secret: string, event: unknown) {
  const body = JSON.stringify(event);
  return app().request(`/hooks/chatwoot/${hookId}`, { method: 'POST', body, headers: signedHeaders(secret, body) });
}

beforeEach(async () => {
  db ??= await freshDb();
  await db.query('truncate agent.teams restart identity cascade');
  queued = [];
  queueAccepts = true;
});

afterAll(async () => {
  await db?.end();
});

describe('POST /hooks/chatwoot/:hookId', () => {
  it('saves a customer message and queues a turn for its conversation', async () => {
    const { teamId, hookId, secret } = await createTestTeam(db);

    const response = await post(hookId, secret, customerMessageEvent());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'queued' });
    expect(queued).toEqual([{ teamId, conversationId: 55 }]);
    const events = await db.query('select kind, message_id, conversation_id from agent.events');
    expect(events.rows).toEqual([{ kind: 'message_created', message_id: '101', conversation_id: '55' }]);
  });

  it('skips a duplicate delivery of the same message', async () => {
    const { hookId, secret } = await createTestTeam(db);
    await post(hookId, secret, customerMessageEvent());

    const response = await post(hookId, secret, customerMessageEvent());

    expect(await response.json()).toEqual({ status: 'duplicate' });
    expect(queued).toHaveLength(1);
  });

  it('reports when a turn is already waiting for the conversation', async () => {
    const { hookId, secret } = await createTestTeam(db);
    queueAccepts = false;

    const response = await post(hookId, secret, customerMessageEvent());

    expect(await response.json()).toEqual({ status: 'already queued' });
  });

  it('starts no turn for agent replies, private notes or conversation events', async () => {
    const { hookId, secret } = await createTestTeam(db);

    for (const event of [customerMessageEvent({ id: 201, message_type: 'outgoing' }), customerMessageEvent({ id: 202, private: true })]) {
      const response = await post(hookId, secret, event);
      expect(await response.json()).toEqual({ status: 'ignored' });
    }
    // A resolve is an outcome for the AI agent page, never a reason to answer.
    const resolved = await post(hookId, secret, customerMessageEvent({ id: 203, event: 'conversation_resolved' }));
    expect(await resolved.json()).toEqual({ status: 'recorded' });
    expect(queued).toHaveLength(0);
  });

  it('ignores inboxes the team has not turned on', async () => {
    const { hookId, secret } = await createTestTeam(db, { inboxId: 3 });

    const response = await post(hookId, secret, customerMessageEvent({ inbox: { id: 9 } }));

    expect(await response.json()).toEqual({ status: 'ignored' });
    expect(queued).toHaveLength(0);
  });

  it('does nothing while the team has the agent turned off', async () => {
    const { teamId, hookId, secret } = await createTestTeam(db);
    await db.query("update agent.teams set mode = 'off' where id = $1", [teamId]);

    const response = await post(hookId, secret, customerMessageEvent());

    expect(await response.json()).toEqual({ status: 'ignored' });
    expect(queued).toHaveLength(0);
  });

  it('rejects an unknown hook address', async () => {
    await createTestTeam(db);
    const response = await post('not-a-real-hook', 'bot-signing-secret', customerMessageEvent());
    expect(response.status).toBe(404);
  });

  it('rejects a bad signature', async () => {
    const { hookId } = await createTestTeam(db);
    const response = await post(hookId, 'wrong-secret', customerMessageEvent());
    expect(response.status).toBe(401);
    expect(queued).toHaveLength(0);
  });

  it('rejects an event for another account', async () => {
    const { hookId, secret } = await createTestTeam(db, { accountId: 1 });
    const response = await post(hookId, secret, customerMessageEvent({ account: { id: 2 } }));
    expect(response.status).toBe(403);
  });
});

describe('GET /health', () => {
  it('answers ok when the database is reachable', async () => {
    const response = await app().request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});

describe('outcomes from the app', () => {
  it('records a teammate reply, a resolve and a reopen for conversations Magpie worked on', async () => {
    const { teamId, hookId, secret } = await createTestTeam(db);
    await db.query('insert into agent.conversations (team_id, conversation_id) values ($1, 55)', [teamId]);
    const send = async (event: Record<string, unknown>) => {
      const body = JSON.stringify({ account: { id: 1 }, ...event });
      return (await app().request(`/hooks/chatwoot/${hookId}`, { method: 'POST', headers: signedHeaders(secret, body), body })).json();
    };

    expect(await send({ event: 'message_created', id: 200, message_type: 'outgoing', private: false, sender: { type: 'user' }, conversation: { id: 55 }, inbox: { id: 3 } })).toEqual({ status: 'recorded' });
    expect(await send({ event: 'conversation_resolved', id: 55 })).toEqual({ status: 'recorded' });
    let row = (await db.query('select person_replied, resolved_at, reopened from agent.conversations')).rows[0];
    expect(row.person_replied).toBe(true);
    expect(row.resolved_at).not.toBeNull();

    await send({ event: 'conversation_opened', id: 55 });
    row = (await db.query('select resolved_at, reopened from agent.conversations')).rows[0];
    expect(row).toEqual({ resolved_at: null, reopened: 1 });
  });
});
