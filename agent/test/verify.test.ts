import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppClient, AppMessage } from '../src/chatwoot.js';
import type { BrainClient, BrainTurnRequest, BrainTurnResult } from '../src/brain.js';
import type { Db } from '../src/db.js';
import { handleTurn } from '../src/jobs/turn.js';
import { checkCode, sendCode } from '../src/verify.js';
import { createTestTeam, ENCRYPTION_KEY, freshDb } from './helpers.js';

let db: Db;

function fakeApp(messages: AppMessage[]) {
  const codes: Array<{ email: string; code: string }> = [];
  const sent: string[] = [];
  const app: AppClient = {
    getConversation: async () => ({ id: 55, status: 'pending', meta: { sender: { id: 9, name: 'Maya' }, channel: 'Channel::WebWidget' } }),
    listMessages: async () => messages,
    createPrivateNote: async () => undefined,
    openConversation: async () => undefined,
    sendReply: async (_a, _c, content) => void sent.push(content),
    sendVerificationEmail: async (_account, email, code) => void codes.push({ email, code }),
    listPortals: async () => [],
    listPublishedArticles: async () => [],
  };
  return { app, codes, sent };
}

function fakeBrain(result: Partial<BrainTurnResult>) {
  const requests: BrainTurnRequest[] = [];
  const brain: BrainClient = {
    runTurn: async request => {
      requests.push(request);
      return {
        reply: 'Hi',
        sources: [],
        check: { passed: true, unsupported: [] },
        handoff_note: null,
        guard: { flagged: false },
        tools: [],
        proposals: [],
        handoff: null,
        seconds: 1,
        cost_usd: '0.004',
        tokens: {},
        ...result,
      };
    },
    grade: async () => ({ verdict: 'same', reason: '', cost_usd: '0' }),
    putKnowledge: async () => ({ articles: 0, pieces: 0 }),
  };
  return { brain, requests };
}

const say = (id: number, content: string): AppMessage => ({ id, content, message_type: 0, private: false, created_at: id });

beforeEach(async () => {
  db ??= await freshDb();
  await db.query('truncate agent.teams restart identity cascade');
});

afterAll(async () => {
  await db?.end();
});

describe('email verification codes', () => {
  it('in Auto, emails the code after the reply, then treats the typed code as proof of the email', async () => {
    const { teamId } = await createTestTeam(db);
    await db.query("update agent.teams set mode = 'auto' where id = $1", [teamId]);
    const turn = (app: AppClient, brain: BrainClient, id: string) =>
      handleTurn({ db, encryptionKey: ENCRYPTION_KEY, appClientFor: () => app, brain, verificationEmails: true }, { id, data: { teamId, conversationId: 55 } });

    const first = fakeApp([say(3, 'Was I charged twice? My email is maya@example.com')]);
    const asking = fakeBrain({ reply: 'I sent a 6-digit code to maya@example.com. Please type it here.', verification_email: 'maya@example.com' });
    await turn(first.app, asking.brain, 'j1');
    expect(asking.requests[0]).toMatchObject({ can_verify_email: true, verification: null, customer: { verified: false } });
    expect(first.sent).toHaveLength(1);
    expect(first.codes).toHaveLength(1);
    expect(first.codes[0]!.email).toBe('maya@example.com');

    const second = fakeApp([say(5, `It's ${first.codes[0]!.code}`)]);
    const answering = fakeBrain({ reply: 'Thanks, you are verified.' });
    await turn(second.app, answering.brain, 'j2');
    expect(answering.requests[0]).toMatchObject({ verification: 'passed', customer: { email: 'maya@example.com', verified: true } });
  });

  it('counts wrong codes, gives up after five, and sends at most three codes a conversation', async () => {
    const { teamId } = await createTestTeam(db);
    await db.query('insert into agent.conversations (team_id, conversation_id) values ($1, 55)', [teamId]);
    const { app, codes } = fakeApp([]);
    expect(await sendCode(db, app, { teamId, accountId: 1 }, 55, 'Maya@Example.com')).toBe(true);
    const right = codes[0]!.code;
    const wrong = right === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt <= 5; attempt++) expect(await checkCode(db, teamId, 55, [`code ${wrong}`])).toBe('failed');
    expect(await checkCode(db, teamId, 55, [right])).toBeNull(); // no code waits any more
    expect(await checkCode(db, teamId, 55, ['no numbers here'])).toBeNull();

    expect(await sendCode(db, app, { teamId, accountId: 1 }, 55, 'maya@example.com')).toBe(true);
    expect(await sendCode(db, app, { teamId, accountId: 1 }, 55, 'maya@example.com')).toBe(true);
    expect(await sendCode(db, app, { teamId, accountId: 1 }, 55, 'maya@example.com')).toBe(false);
    expect(codes).toHaveLength(3);
  });

  it('never offers a code when the app has no email set up', async () => {
    const { teamId } = await createTestTeam(db);
    const { app } = fakeApp([say(3, 'Was I charged twice?')]);
    const { brain, requests } = fakeBrain({});
    await handleTurn({ db, encryptionKey: ENCRYPTION_KEY, appClientFor: () => app, brain }, { id: 'j1', data: { teamId, conversationId: 55 } });
    expect(requests[0]!.can_verify_email).toBe(false);
  });
});
