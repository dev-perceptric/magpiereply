import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppClient, AppMessage } from '../src/chatwoot.js';
import type { BrainClient, BrainTurnResult } from '../src/brain.js';
import type { Db } from '../src/db.js';
import { handleTurn, reasonToHoldBack } from '../src/jobs/turn.js';
import { latestDraft } from '../src/repo.js';
import { setFlag } from '../src/trust.js';
import { createTestTeam, ENCRYPTION_KEY, freshDb } from './helpers.js';

let db: Db;

const CUSTOMER = (id: number, content: string): AppMessage => ({ id, content, message_type: 0, private: false, created_at: id });

function fakeApp(options: { messages?: AppMessage[]; failSend?: boolean } = {}) {
  const calls = { sent: [] as string[], notes: [] as string[], opened: [] as number[] };
  const appClientFor = (): AppClient => ({
    getConversation: async () => ({
      id: 55,
      status: 'pending',
      meta: { sender: { id: 9, name: 'Maya', email: 'maya@example.com' }, channel: 'Channel::WebWidget', hmac_verified: true },
    }),
    listMessages: async () => options.messages ?? [CUSTOMER(3, 'Do you ship to Canada?')],
    createPrivateNote: async (_account, _conversation, content) => void calls.notes.push(content),
    openConversation: async (_account, conversationId) => void calls.opened.push(conversationId),
    sendReply: async (_account, _conversation, content) => {
      if (options.failSend) throw new Error('app unavailable');
      calls.sent.push(content);
    },
    sendVerificationEmail: async () => undefined,
    listPortals: async () => [],
    listPublishedArticles: async () => [],
  });
  return { appClientFor, calls };
}

function fakeBrain(result: Partial<BrainTurnResult> = {}) {
  let asked = 0;
  const brain: BrainClient = {
    runTurn: async () => {
      asked += 1;
      return {
        reply: 'Yes, we ship to Canada in 5 business days.',
        sources: [{ id: '12', title: 'Shipping to Canada', url: null }],
        check: { passed: true, unsupported: [] },
        handoff_note: null,
        guard: { flagged: false },
        masked_messages: 0,
        tools: [],
        proposals: [],
        handoff: null,
        seconds: 2,
        cost_usd: '0.00400',
        tokens: {},
        ...result,
      };
    },
    grade: async () => ({ verdict: 'same', reason: '', cost_usd: '0' }),
    putKnowledge: async () => ({ articles: 0, pieces: 0 }),
  };
  return { brain, asked: () => asked };
}

async function autoTeam() {
  const { teamId } = await createTestTeam(db);
  await db.query("update agent.teams set mode = 'auto' where id = $1", [teamId]);
  return teamId;
}

const turn = (teamId: number, app: ReturnType<typeof fakeApp>, brain: BrainClient, id = 'j1', retryCount = 0) =>
  handleTurn({ db, encryptionKey: ENCRYPTION_KEY, appClientFor: app.appClientFor, brain }, { id, data: { teamId, conversationId: 55 }, retryCount });

beforeEach(async () => {
  db ??= await freshDb();
  await db.query('truncate agent.teams restart identity cascade');
  await db.query('delete from agent.flags');
});

afterAll(async () => {
  await db?.end();
});

describe('Auto mode', () => {
  it('sends a checked reply itself, leaves the conversation with Magpie and records the cost', async () => {
    const teamId = await autoTeam();
    const app = fakeApp();
    await turn(teamId, app, fakeBrain().brain);

    expect(app.calls.sent).toEqual(['Yes, we ship to Canada in 5 business days.']);
    expect(app.calls.notes).toEqual([]);
    expect(app.calls.opened).toEqual([]);
    expect(await latestDraft(db, teamId, 55)).toMatchObject({ status: 'sent', sentBy: 'magpie' });
    const row = (await db.query('select auto_replies, pending_reply from agent.conversations')).rows[0];
    expect(row).toEqual({ auto_replies: 1, pending_reply: null });
    expect(Number((await db.query('select cost_usd from agent.runs')).rows[0].cost_usd)).toBe(0.004);
  });

  it.each([
    ['the fact check fails', { check: { passed: false, unsupported: ['in 5 business days'] } }, "the fact check found something that isn't in your knowledge"],
    ['the message looks like an attack', { guard: { flagged: true } }, 'the message looks like an attempt to steer Magpie'],
    ['money is involved', { proposals: [{ action: 'refund', charge_id: 'pi_2', amount: '34.00 USD', approval: 'customer_confirms' as const }] }, 'it involves a refund'],
  ])('keeps a draft for people when %s', async (_case, result, reason) => {
    const teamId = await autoTeam();
    const app = fakeApp();
    await turn(teamId, app, fakeBrain(result).brain);

    expect(app.calls.sent).toEqual([]);
    expect(app.calls.notes[0]).toContain(`Not sent on its own because ${reason}.`);
    expect(app.calls.opened).toEqual([55]);
    expect(await latestDraft(db, teamId, 55)).toMatchObject({ status: 'pending' });
  });

  it('sends the reply once when the first send failed, without asking the brain again', async () => {
    const teamId = await autoTeam();
    const { brain, asked } = fakeBrain();
    await expect(turn(teamId, fakeApp({ failSend: true }), brain)).rejects.toThrow('app unavailable');
    expect((await db.query('select pending_reply from agent.conversations')).rows[0].pending_reply).toContain('Canada');

    const working = fakeApp();
    await turn(teamId, working, brain, 'j1', 1);
    expect(working.calls.sent).toEqual(['Yes, we ship to Canada in 5 business days.']);
    expect(asked()).toBe(1);
    expect(await latestDraft(db, teamId, 55)).toMatchObject({ status: 'sent', sentBy: 'magpie' });
  });

  it('answers and hands off, with the note for the person taking over', async () => {
    const teamId = await autoTeam();
    const app = fakeApp();
    await turn(teamId, app, fakeBrain({ reply: "I'm passing you to our billing team.", handoff: { team: 'Billing', reason: 'chargeback' }, handoff_note: 'Maya wants to reverse a charge.' }).brain);

    expect(app.calls.sent).toEqual(["I'm passing you to our billing team."]);
    expect(app.calls.notes[0]).toBe('Magpie answered and suggests handing off to Billing: chargeback\n\nFor the person taking over: Maya wants to reverse a charge.');
    expect(app.calls.opened).toEqual([55]);
  });

  it('goes to people after two answers of its own when the customer is still writing', async () => {
    const teamId = await autoTeam();
    const { brain, asked } = fakeBrain();
    await turn(teamId, fakeApp({ messages: [CUSTOMER(3, 'Do you ship to Canada?')] }), brain, 'j1');
    await turn(teamId, fakeApp({ messages: [CUSTOMER(5, 'How long exactly?')] }), brain, 'j2');
    const third = fakeApp({ messages: [CUSTOMER(7, 'That is not what I asked')] });
    await turn(teamId, third, brain, 'j3');

    expect(asked()).toBe(2);
    expect(third.calls.notes[0]).toBe('Magpie answered 2 times and the customer is still writing. Over to you.');
    expect(third.calls.opened).toEqual([55]);
    expect((await db.query('select handed_off from agent.conversations')).rows[0].handed_off).toBe(true);
  });

  it('acts as Draft mode while Auto is paused for every team', async () => {
    const teamId = await autoTeam();
    await setFlag(db, 'auto_paused', true);
    const app = fakeApp();
    await turn(teamId, app, fakeBrain().brain);

    expect(app.calls.sent).toEqual([]);
    expect(app.calls.notes[0]).toContain('Magpie draft');
  });

  it('stops reading conversations when everything is paused, and shows Auto conversations to people', async () => {
    const teamId = await autoTeam();
    await setFlag(db, 'all_paused', true);
    const app = fakeApp();
    const { brain, asked } = fakeBrain();
    await turn(teamId, app, brain);

    expect(asked()).toBe(0);
    expect(app.calls.opened).toEqual([55]);
  });

  it("stops calling the brain at the team's monthly limit and hands Auto conversations to people", async () => {
    const teamId = await autoTeam();
    await db.query('update agent.teams set monthly_cap_usd = 0.01 where id = $1', [teamId]);
    await db.query("insert into agent.runs (team_id, conversation_id, status, cost_usd) values ($1, 1, 'done', 0.01)", [teamId]);
    const app = fakeApp();
    const { brain, asked } = fakeBrain();
    await turn(teamId, app, brain);

    expect(asked()).toBe(0);
    expect(app.calls.notes[0]).toBe("Magpie reached this month's limit of $0.01, so a person needs to answer.");
    expect(app.calls.opened).toEqual([55]);
  });

  it('never sends a reply that was not checked', () => {
    expect(reasonToHoldBack({ reply: 'Hi', check: null } as BrainTurnResult)).toBe("the reply wasn't checked");
    expect(reasonToHoldBack({ reply: null } as BrainTurnResult)).toBe('there is no reply');
  });
});
