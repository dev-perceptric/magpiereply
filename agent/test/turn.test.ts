import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppClient, AppConversation, AppMessage } from '../src/chatwoot.js';
import type { BrainClient, BrainTurnRequest, BrainTurnResult } from '../src/brain.js';
import type { Db } from '../src/db.js';
import { customerOf, handleTurn, historyOf } from '../src/jobs/turn.js';
import { createTestTeam, ENCRYPTION_KEY, freshDb } from './helpers.js';
import { latestDraft } from '../src/repo.js';

let db: Db;

function fakeApp(options: { messages?: AppMessage[]; failNote?: boolean; conversation?: AppConversation } = {}) {
  const calls = { tokens: [] as string[], notes: [] as Array<{ accountId: number; conversationId: number; content: string }>, opened: [] as number[] };
  const appClientFor = (token: string): AppClient => {
    calls.tokens.push(token);
    return {
      getConversation: async () =>
        options.conversation ?? {
          id: 55,
          status: 'pending',
          meta: { sender: { id: 9, name: 'Maya', email: 'maya@example.com' }, channel: 'Channel::WebWidget', hmac_verified: true },
        },
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
      openConversation: async (_accountId, conversationId) => {
        calls.opened.push(conversationId);
      },
      sendReply: async () => {
        throw new Error('a turn never sends to the customer');
      },
      listPortals: async () => [],
      listPublishedArticles: async () => [],
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

function fakeBrain(result: Partial<BrainTurnResult> = {}, options: { fail?: boolean } = {}) {
  const requests: BrainTurnRequest[] = [];
  const brain: BrainClient = {
    runTurn: async request => {
      requests.push(request);
      if (options.fail) throw new Error('brain unavailable');
      return {
        reply: 'I see two charges of $34.00. Shall I refund the duplicate?',
        sources: [],
        check: { passed: true, unsupported: [] },
        handoff_note: null,
        tools: [{ name: 'list_recent_charges', arguments: {} }],
        proposals: [{ action: 'refund', charge_id: 'pi_2', amount: '34.00 USD', approval: 'customer_confirms' }],
        handoff: null,
        seconds: 3.2,
        cost_usd: '0.01200',
        tokens: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 80 },
        ...result,
      };
    },
    grade: async () => ({ verdict: 'same', reason: '', cost_usd: '0' }),
    putKnowledge: async () => ({ articles: 0, pieces: 0 }),
  };
  return { brain, requests };
}

describe('handleTurn with the brain', () => {
  it('sends the conversation with the verified customer and posts the draft as a note', async () => {
    const { teamId } = await createTestTeam(db, { accountId: 4 });
    const { appClientFor, calls } = fakeApp();
    const { brain, requests } = fakeBrain();

    await handleTurn({ db, encryptionKey: ENCRYPTION_KEY, appClientFor, brain }, { id: 'job-b1', data: { teamId, conversationId: 55 } });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.history).toEqual([
      { role: 'customer', content: 'Hi' },
      { role: 'agent', content: 'Looking into it' },
      { role: 'customer', content: 'I was charged twice' },
    ]);
    expect(requests[0]!.customer).toEqual({ id: '9', name: 'Maya', email: 'maya@example.com', verified: true });
    expect(calls.notes).toHaveLength(1);
    expect(calls.notes[0]!.content).toContain('Shall I refund the duplicate?');
    expect(calls.notes[0]!.content).toContain('Proposed refund: 34.00 USD for pi_2, needs the customer to confirm.');
    expect(calls.opened).toEqual([55]);

    const state = (await db.query('select last_message_id, pending_note from agent.conversations')).rows[0];
    expect(state).toEqual({ last_message_id: '3', pending_note: null });
    const step = (await db.query("select tokens_in, tokens_out from agent.run_steps where name = 'brain'")).rows[0];
    expect(step).toEqual({ tokens_in: 1000, tokens_out: 80 });
    const draft = (await db.query('select conversation_id, reply, proposals, status from agent.drafts')).rows[0];
    expect(draft).toEqual({
      conversation_id: '55',
      reply: 'I see two charges of $34.00. Shall I refund the duplicate?',
      proposals: [{ action: 'refund', charge_id: 'pi_2', amount: '34.00 USD', approval: 'customer_confirms' }],
      status: 'pending',
    });
  });

  it('asks the brain only when the customer wrote something new, and leaves private drafts out', async () => {
    const { teamId } = await createTestTeam(db);
    const first = fakeApp();
    const { brain, requests } = fakeBrain();
    await handleTurn({ db, encryptionKey: ENCRYPTION_KEY, appClientFor: first.appClientFor, brain }, { id: 'j1', data: { teamId, conversationId: 55 } });
    await handleTurn({ db, encryptionKey: ENCRYPTION_KEY, appClientFor: first.appClientFor, brain }, { id: 'j2', data: { teamId, conversationId: 55 } });
    expect(requests).toHaveLength(1);

    const later = fakeApp({
      messages: [
        { id: 3, content: 'I was charged twice', message_type: 0, private: false, created_at: 3 },
        { id: 4, content: 'Magpie draft', message_type: 1, private: true, created_at: 4 },
        { id: 5, content: 'Yes please refund it', message_type: 0, private: false, created_at: 5 },
      ],
    });
    await handleTurn({ db, encryptionKey: ENCRYPTION_KEY, appClientFor: later.appClientFor, brain }, { id: 'j3', data: { teamId, conversationId: 55 } });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.history).toEqual([
      { role: 'customer', content: 'I was charged twice' },
      { role: 'customer', content: 'Yes please refund it' },
    ]);
  });

  it('posts a saved draft on retry without asking the brain again when the note failed', async () => {
    const { teamId } = await createTestTeam(db);
    const { brain, requests } = fakeBrain();
    const broken = fakeApp({ failNote: true });
    await expect(
      handleTurn({ db, encryptionKey: ENCRYPTION_KEY, appClientFor: broken.appClientFor, brain }, { id: 'j1', data: { teamId, conversationId: 55 } }),
    ).rejects.toThrow('app unavailable');
    const pending = (await db.query('select pending_note from agent.conversations')).rows[0];
    expect(pending.pending_note).toContain('Shall I refund the duplicate?');

    const working = fakeApp();
    await handleTurn(
      { db, encryptionKey: ENCRYPTION_KEY, appClientFor: working.appClientFor, brain },
      { id: 'j1', data: { teamId, conversationId: 55 }, retryCount: 1 },
    );
    expect(requests).toHaveLength(1);
    expect(working.calls.notes).toHaveLength(1);
    expect((await db.query('select pending_note from agent.conversations')).rows[0].pending_note).toBeNull();
  });

  it('a brain failure fails the run so the queue retries, and saves nothing', async () => {
    const { teamId } = await createTestTeam(db);
    const { appClientFor, calls } = fakeApp();
    const { brain } = fakeBrain({}, { fail: true });
    await expect(
      handleTurn({ db, encryptionKey: ENCRYPTION_KEY, appClientFor, brain }, { id: 'j1', data: { teamId, conversationId: 55 } }),
    ).rejects.toThrow('brain unavailable');
    expect(calls.notes).toHaveLength(0);
    expect((await db.query('select count(*)::int as n from agent.conversations')).rows[0].n).toBe(0);
  });

  it('stops drafting once the conversation is handed off', async () => {
    const { teamId } = await createTestTeam(db);
    const { brain, requests } = fakeBrain({ proposals: [], handoff: { team: 'Billing', reason: 'chargeback' } });
    const first = fakeApp();
    await handleTurn({ db, encryptionKey: ENCRYPTION_KEY, appClientFor: first.appClientFor, brain }, { id: 'j1', data: { teamId, conversationId: 55 } });
    expect(first.calls.notes[0]!.content).toContain('Suggested handoff to Billing: chargeback');

    const later = fakeApp({ messages: [{ id: 9, content: 'hello?', message_type: 0, private: false, created_at: 9 }] });
    await handleTurn({ db, encryptionKey: ENCRYPTION_KEY, appClientFor: later.appClientFor, brain }, { id: 'j2', data: { teamId, conversationId: 55 } });
    expect(requests).toHaveLength(1);
    expect(later.calls.notes).toHaveLength(0);
  });
});

describe('customerOf', () => {
  const base = { id: 55, meta: { sender: { id: 9, name: 'Maya', email: 'maya@example.com' } } };

  it('puts the sources, the fact check and the handoff note in the note and the draft', async () => {
    const { teamId } = await createTestTeam(db, { accountId: 4 });
    const { appClientFor, calls } = fakeApp();
    const { brain } = fakeBrain({
      reply: 'Refunds take 2 days.',
      sources: [{ id: '12', title: 'Refunds', url: 'https://app.example.com/hc/help/articles/refunds' }],
      check: { passed: false, unsupported: ['Refunds take 2 days.'] },
      proposals: [],
      handoff: { team: 'Billing', reason: 'chargeback' },
      handoff_note: 'Maya wants to reverse a March charge.',
    });

    await handleTurn({ db, encryptionKey: ENCRYPTION_KEY, appClientFor, brain }, { id: 'job-s1', data: { teamId, conversationId: 55 } });

    const note = calls.notes[0]!.content;
    expect(note).toContain('Check before sending. Not found in your knowledge:\n- Refunds take 2 days.');
    expect(note).toContain('Sources:\n- Refunds (https://app.example.com/hc/help/articles/refunds)');
    expect(note).toContain('For the person taking over: Maya wants to reverse a March charge.');
    const draft = await latestDraft(db, teamId, 55);
    expect(draft).toMatchObject({
      sources: [{ id: '12', title: 'Refunds' }],
      factCheck: { passed: false, unsupported: ['Refunds take 2 days.'] },
      handoffNote: 'Maya wants to reverse a March charge.',
    });
  });

  it('trusts the widget identity check or the email channel only', () => {
    expect(customerOf({ ...base, meta: { ...base.meta, channel: 'Channel::WebWidget', hmac_verified: true } }).verified).toBe(true);
    expect(customerOf({ ...base, meta: { ...base.meta, channel: 'Channel::Email' } }).verified).toBe(true);
    expect(customerOf({ ...base, meta: { ...base.meta, channel: 'Channel::WebWidget', hmac_verified: false } }).verified).toBe(false);
  });

  it('is never verified without an email', () => {
    expect(customerOf({ id: 55, meta: { sender: { id: 9, email: null }, channel: 'Channel::Email' } }).verified).toBe(false);
  });
});

describe('historyOf', () => {
  it('ends on the customer, without private notes or activity messages', () => {
    const history = historyOf([
      { id: 1, content: 'Hi', message_type: 0, private: false, created_at: 1 },
      { id: 2, content: 'Conversation assigned', message_type: 2, private: false, created_at: 2 },
      { id: 3, content: 'Magpie draft', message_type: 1, private: true, created_at: 3 },
      { id: 4, content: 'How can we help?', message_type: 1, private: false, created_at: 4 },
      { id: 5, content: 'Charged twice', message_type: 0, private: false, created_at: 5 },
      { id: 6, content: 'Looking now', message_type: 1, private: false, created_at: 6 },
    ]);
    expect(history).toEqual([
      { role: 'customer', content: 'Hi' },
      { role: 'agent', content: 'How can we help?' },
      { role: 'customer', content: 'Charged twice' },
    ]);
  });
});
