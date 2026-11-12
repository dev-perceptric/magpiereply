import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppClient } from '../src/chatwoot.js';
import { hashHookId } from '../src/crypto.js';
import type { Db } from '../src/db.js';
import { createHttpApp } from '../src/http.js';
import { saveDraft, setPanelKeyHash } from '../src/repo.js';
import { createTestTeam, ENCRYPTION_KEY, freshDb } from './helpers.js';

let db: Db;
const PANEL_KEY = 'panel-key-long-and-random';

function setup(options: { failSend?: boolean } = {}) {
  const sent: Array<{ accountId: number; conversationId: number; content: string }> = [];
  const app: AppClient = {
    getConversation: async () => ({ id: 1, meta: {} }),
    listMessages: async () => [],
    createPrivateNote: async () => undefined,
    openConversation: async () => undefined,
    sendReply: async (accountId, conversationId, content) => {
      if (options.failSend) throw new Error('app down');
      sent.push({ accountId, conversationId, content });
    },
    sendVerificationEmail: async () => undefined,
    listPortals: async () => [],
    listPublishedArticles: async () => [],
  };
  const http = createHttpApp({
    db,
    encryptionKey: ENCRYPTION_KEY,
    enqueueTurn: async () => true,
    healthCheck: async () => undefined,
    panel: { appClientFor: () => app, publicAppUrl: 'https://app.example.com' },
  });
  return { http, sent };
}

async function draftFor(teamId: number, conversationId = 55) {
  const runId = Number((await db.query('insert into agent.runs (team_id, conversation_id) values ($1, $2) returning id', [teamId, conversationId])).rows[0].id);
  return saveDraft(db, { teamId, conversationId, runId, reply: 'Yes, we ship to Canada.', proposals: [], handoff: null });
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(async () => {
  db ??= await freshDb();
  await db.query('truncate agent.teams restart identity cascade');
});

afterAll(async () => {
  await db?.end();
});

describe('the drafts side panel', () => {
  it('serves its page only to the right key, framed only by the app', async () => {
    await createTestTeam(db, { accountId: 4 });
    await setPanelKeyHash(db, 4, hashHookId(PANEL_KEY));
    const { http } = setup();

    const page = await http.request(`/panel/${PANEL_KEY}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toBe('frame-ancestors https://app.example.com');
    const script = (await page.text()).split('<script>')[1]!.split('</script>')[0]!;
    expect(() => new Function(script)).not.toThrow(); // the page's script still parses
    expect((await http.request('/panel/wrong-key')).status).toBe(404);
  });

  it("shows a conversation's latest draft, and a newer draft replaces the older one", async () => {
    const { teamId } = await createTestTeam(db, { accountId: 4 });
    await setPanelKeyHash(db, 4, hashHookId(PANEL_KEY));
    const first = await draftFor(teamId);
    const second = await draftFor(teamId);
    const { http } = setup();

    const response = await http.request(`/panel/${PANEL_KEY}/conversations/55/draft`);
    const body = (await response.json()) as { draft: { id: number; status: string } };
    expect(body.draft).toMatchObject({ id: second, status: 'pending' });
    const old = (await db.query('select status from agent.drafts where id = $1', [first])).rows[0];
    expect(old.status).toBe('replaced');
  });

  it('sends the edited reply once, as the bot, and never twice', async () => {
    const { teamId } = await createTestTeam(db, { accountId: 4 });
    await setPanelKeyHash(db, 4, hashHookId(PANEL_KEY));
    const draftId = await draftFor(teamId);
    const { http, sent } = setup();

    const response = await http.request(`/panel/${PANEL_KEY}/drafts/${draftId}/send`, json({ content: 'Yes! We ship to Canada.', actedBy: 'Jo' }));
    expect(response.status).toBe(200);
    expect(sent).toEqual([{ accountId: 4, conversationId: 55, content: 'Yes! We ship to Canada.' }]);
    const row = (await db.query('select status, sent_content, acted_by from agent.drafts where id = $1', [draftId])).rows[0];
    expect(row).toEqual({ status: 'sent', sent_content: 'Yes! We ship to Canada.', acted_by: 'Jo' });

    const again = await http.request(`/panel/${PANEL_KEY}/drafts/${draftId}/send`, json({ content: 'Again', actedBy: 'Jo' }));
    expect(again.status).toBe(409);
    expect(sent).toHaveLength(1);
  });

  it('puts the draft back when the app fails to send it', async () => {
    const { teamId } = await createTestTeam(db, { accountId: 4 });
    await setPanelKeyHash(db, 4, hashHookId(PANEL_KEY));
    const draftId = await draftFor(teamId);
    const { http } = setup({ failSend: true });

    const response = await http.request(`/panel/${PANEL_KEY}/drafts/${draftId}/send`, json({ content: 'Hi', actedBy: 'Jo' }));
    expect(response.status).toBe(502);
    expect((await db.query('select status from agent.drafts where id = $1', [draftId])).rows[0].status).toBe('pending');
  });

  it("can't act on another team's draft or send an empty reply", async () => {
    const { teamId: otherTeam } = await createTestTeam(db, { accountId: 9 });
    await createTestTeam(db, { accountId: 4 });
    await setPanelKeyHash(db, 4, hashHookId(PANEL_KEY));
    const othersDraft = await draftFor(otherTeam);
    const { http, sent } = setup();

    expect((await http.request(`/panel/${PANEL_KEY}/drafts/${othersDraft}/send`, json({ content: 'Hi', actedBy: 'Jo' }))).status).toBe(409);
    expect((await http.request(`/panel/${PANEL_KEY}/drafts/${othersDraft}/send`, json({ content: '  ', actedBy: 'Jo' }))).status).toBe(422);
    expect(sent).toHaveLength(0);
  });

  it('discards a draft without sending anything', async () => {
    const { teamId } = await createTestTeam(db, { accountId: 4 });
    await setPanelKeyHash(db, 4, hashHookId(PANEL_KEY));
    const draftId = await draftFor(teamId);
    const { http, sent } = setup();

    expect((await http.request(`/panel/${PANEL_KEY}/drafts/${draftId}/discard`, json({ actedBy: 'Jo' }))).status).toBe(200);
    expect(sent).toHaveLength(0);
    expect((await db.query('select status from agent.drafts where id = $1', [draftId])).rows[0].status).toBe('discarded');
  });
});
