import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { decrypt, hashHookId } from '../src/crypto.js';
import type { Db } from '../src/db.js';
import { createHttpApp } from '../src/http.js';
import { findTeamByHookHash, findTeamByPanelHash } from '../src/repo.js';
import { ENCRYPTION_KEY, freshDb } from './helpers.js';

let db: Db;
const queued = { reads: [] as number[], syncs: [] as number[] };
const KEY = 'internal-key-that-is-at-least-32-chars';

function app() {
  return createHttpApp({
    db,
    encryptionKey: ENCRYPTION_KEY,
    enqueueTurn: async () => true,
    healthCheck: async () => undefined,
    internal: {
      internalApiKey: KEY,
      publicUrl: 'https://agent.example.com',
      enqueueRead: async sourceId => {
        queued.reads.push(sourceId);
      },
      enqueueSync: async teamId => {
        queued.syncs.push(teamId);
      },
    },
  });
}

const call = (method: string, body?: unknown, key = KEY) => ({
  method,
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const connect = { name: 'Acme', bot_id: 7, bot_token: 'bot-key', bot_secret: 'bot-secret' };

beforeEach(async () => {
  db ??= await freshDb();
  await db.query('truncate agent.teams restart identity cascade');
  queued.reads = [];
  queued.syncs = [];
});

afterAll(async () => {
  await db?.end();
});

describe('the internal API for the settings page', () => {
  it('refuses a missing or wrong key', async () => {
    expect((await app().request('/internal/accounts/4')).status).toBe(401);
    expect((await app().request('/internal/accounts/4', call('GET', undefined, 'wrong'))).status).toBe(401);
  });

  it('reports an account that was never connected as off', async () => {
    const response = await app().request('/internal/accounts/4', call('GET'));
    expect(await response.json()).toEqual({ connected: false, mode: 'off', inbox_ids: [] });
  });

  it('connects an account with its bot and hands back working webhook and panel addresses', async () => {
    const response = await app().request('/internal/accounts/4/connect', call('POST', connect));
    const body = (await response.json()) as { hook_url: string; panel_url: string };
    expect(response.status).toBe(200);

    const hookId = body.hook_url.replace('https://agent.example.com/hooks/chatwoot/', '');
    const panelKey = body.panel_url.replace('https://agent.example.com/panel/', '');
    const team = await findTeamByHookHash(db, hashHookId(hookId));
    expect(team).toMatchObject({ accountId: 4, botId: 7, mode: 'draft' });
    expect(decrypt(team!.botTokenEnc, ENCRYPTION_KEY)).toBe('bot-key');
    expect(await findTeamByPanelHash(db, hashHookId(panelKey))).toMatchObject({ accountId: 4 });
  });

  it('reconnecting replaces both addresses, so old ones stop working', async () => {
    const first = (await (await app().request('/internal/accounts/4/connect', call('POST', connect))).json()) as { hook_url: string; panel_url: string };
    await app().request('/internal/accounts/4/connect', call('POST', connect));
    const oldHook = first.hook_url.split('/').pop()!;
    const oldPanel = first.panel_url.split('/').pop()!;
    expect(await findTeamByHookHash(db, hashHookId(oldHook))).toBeNull();
    expect(await findTeamByPanelHash(db, hashHookId(oldPanel))).toBeNull();
  });

  it('sets the mode and exactly the chosen inboxes', async () => {
    await app().request('/internal/accounts/4/connect', call('POST', connect));
    await app().request('/internal/accounts/4', call('PUT', { mode: 'draft', inbox_ids: [1, 2, 3] }));
    const response = await app().request('/internal/accounts/4', call('PUT', { mode: 'draft', inbox_ids: [2, 5] }));
    expect(await response.json()).toEqual({ connected: true, mode: 'draft', inbox_ids: [2, 5] });

    const off = await app().request('/internal/accounts/4', call('PUT', { mode: 'off', inbox_ids: [] }));
    expect(await off.json()).toEqual({ connected: true, mode: 'off', inbox_ids: [] });
  });

  it("won't set Auto mode yet or settings for an account that isn't connected", async () => {
    expect((await app().request('/internal/accounts/4', call('PUT', { mode: 'draft', inbox_ids: [1] }))).status).toBe(409);
    await app().request('/internal/accounts/4/connect', call('POST', connect));
    expect((await app().request('/internal/accounts/4', call('PUT', { mode: 'auto', inbox_ids: [1] }))).status).toBe(422);
  });

  it('is off entirely when no key is configured', async () => {
    const plain = createHttpApp({ db, encryptionKey: ENCRYPTION_KEY, enqueueTurn: async () => true, healthCheck: async () => undefined });
    expect((await plain.request('/internal/accounts/4', call('GET'))).status).toBe(404);
  });
});

describe('websites and files', () => {
  const upload = (name: string, content: string) => {
    const form = new FormData();
    form.append('file', new Blob([content]), name);
    return { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: form };
  };

  it('adds a website, queues a read and lists it', async () => {
    await app().request('/internal/accounts/4/connect', call('POST', connect));
    const added = await app().request('/internal/accounts/4/sources', call('POST', { url: 'https://tidewell.example.com/help' }));
    expect(added.status).toBe(201);
    const { source } = (await added.json()) as { source: { id: number } };
    expect(queued.reads).toEqual([source.id]);

    const listed = (await (await app().request('/internal/accounts/4/sources', call('GET'))).json()) as { sources: unknown[] };
    expect(listed.sources).toEqual([
      { id: source.id, kind: 'website', name: 'https://tidewell.example.com/help', status: 'reading', error: null, pages: 0, read_at: null },
    ]);
  });

  it('refuses a duplicate website, a bad address and a site without http', async () => {
    await app().request('/internal/accounts/4/connect', call('POST', connect));
    await app().request('/internal/accounts/4/sources', call('POST', { url: 'https://tidewell.example.com' }));
    const again = await app().request('/internal/accounts/4/sources', call('POST', { url: 'https://tidewell.example.com/' }));
    expect(await again.json()).toEqual({ error: 'That website is already added.' });
    expect((await app().request('/internal/accounts/4/sources', call('POST', { url: 'not a url' }))).status).toBe(422);
    expect((await app().request('/internal/accounts/4/sources', call('POST', { url: 'file:///etc/passwd' }))).status).toBe(422);
  });

  it('stores an uploaded file until it is read and refuses other types', async () => {
    await app().request('/internal/accounts/4/connect', call('POST', connect));
    const added = await app().request('/internal/accounts/4/sources', upload('Returns policy.pdf', '%PDF-1.4 hello'));
    expect(added.status).toBe(201);
    const row = (await db.query("select file_name, file_type, file_data from agent.knowledge_sources where kind = 'file'")).rows[0];
    expect(row).toMatchObject({ file_name: 'Returns policy.pdf', file_type: 'application/pdf' });
    expect(row.file_data.toString()).toBe('%PDF-1.4 hello');

    const refused = await app().request('/internal/accounts/4/sources', upload('virus.exe', 'MZ'));
    expect(refused.status).toBe(422);
  });

  it('removes a source and syncs, and reads one again on request', async () => {
    await app().request('/internal/accounts/4/connect', call('POST', connect));
    const added = await app().request('/internal/accounts/4/sources', call('POST', { url: 'https://tidewell.example.com' }));
    const { source } = (await added.json()) as { source: { id: number } };
    await db.query("update agent.knowledge_sources set status = 'failed'");

    expect((await app().request(`/internal/accounts/4/sources/${source.id}/read`, call('POST'))).status).toBe(200);
    expect(queued.reads).toEqual([source.id, source.id]);
    expect((await db.query('select status from agent.knowledge_sources')).rows[0].status).toBe('reading');

    expect((await app().request(`/internal/accounts/5/sources/${source.id}`, call('DELETE'))).status).toBe(404);
    expect((await app().request(`/internal/accounts/4/sources/${source.id}`, call('DELETE'))).status).toBe(200);
    expect(queued.syncs).toHaveLength(1);
    expect((await db.query('select count(*)::int as n from agent.knowledge_sources')).rows[0].n).toBe(0);
  });
});
