import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { connectionsForTurn, finishConnect, listConnections, startConnect, type AppsDeps } from '../src/apps.js';
import { decrypt } from '../src/crypto.js';
import type { Db } from '../src/db.js';
import { createHttpApp } from '../src/http.js';
import { createTestTeam, ENCRYPTION_KEY, freshDb } from './helpers.js';

let db: Db;

// A provider like Stripe's: protected-resource metadata, an auth server with self-registration, a token endpoint.
function fakeStripe(options: { refreshFails?: boolean } = {}) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://mcp.stripe.com/.well-known/oauth-protected-resource') {
      return json({ resource: 'https://mcp.stripe.com', authorization_servers: ['https://access.stripe.com/mcp'] });
    }
    if (url === 'https://access.stripe.com/.well-known/oauth-authorization-server/mcp') {
      return json({
        issuer: 'https://access.stripe.com/mcp',
        authorization_endpoint: 'https://access.stripe.com/mcp/oauth2/authorize',
        token_endpoint: 'https://access.stripe.com/mcp/oauth2/token',
        registration_endpoint: 'https://access.stripe.com/mcp/oauth2/register',
      });
    }
    if (url === 'https://access.stripe.com/mcp/oauth2/register') return json({ client_id: 'client-1' }, 201);
    if (url === 'https://access.stripe.com/mcp/oauth2/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'refresh_token') {
        return options.refreshFails ? json({ error: 'invalid_grant' }, 400) : json({ access_token: 'fresh-key', expires_in: 3600 });
      }
      return json({ access_token: 'team-key', refresh_token: 'refresh-1', expires_in: 3600 });
    }
    return json({}, 404);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const deps = (fetchFn: typeof fetch, env: Record<string, string> = {}): AppsDeps => ({
  db,
  encryptionKey: ENCRYPTION_KEY,
  publicUrl: 'https://agent.example.com',
  env,
  fetch: fetchFn,
});

beforeEach(async () => {
  db ??= await freshDb();
  await db.query('truncate agent.teams restart identity cascade');
  await db.query('delete from agent.oauth_clients');
});

afterAll(async () => {
  await db?.end();
});

describe('connecting an app', () => {
  it('registers MagpieReply once and sends the admin to the sign-in page with PKCE, state and the resource', async () => {
    const { teamId } = await createTestTeam(db);
    const other = await createTestTeam(db, { accountId: 2 });
    const { fetchFn, calls } = fakeStripe();

    const url = new URL(await startConnect(deps(fetchFn), teamId, 'stripe'));
    await startConnect(deps(fetchFn), other.teamId, 'stripe');

    expect(url.origin + url.pathname).toBe('https://access.stripe.com/mcp/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'client-1',
      redirect_uri: 'https://agent.example.com/connect/callback',
      code_challenge_method: 'S256',
      resource: 'https://mcp.stripe.com',
      scope: 'mcp',
      response_type: 'code',
    });
    expect(url.searchParams.get('state')).toHaveLength(43);
    expect(calls.filter(call => call.url.endsWith('/register'))).toHaveLength(1);
  });

  it('trades the code for keys with the verifier, keeps them encrypted and checks the server', async () => {
    const { teamId } = await createTestTeam(db, { accountId: 4 });
    const { fetchFn, calls } = fakeStripe();
    const url = new URL(await startConnect(deps(fetchFn), teamId, 'stripe'));
    const tested: string[] = [];

    const outcome = await finishConnect(deps(fetchFn), { code: 'code-1', state: url.searchParams.get('state')! }, async (_provider, token) => {
      tested.push(token);
      return 7;
    });

    expect(outcome).toEqual({ accountId: 4, provider: 'stripe', ok: true, message: 'Stripe is connected.' });
    expect(tested).toEqual(['team-key']);
    const form = new URLSearchParams(calls.find(call => call.url.endsWith('/token'))!.body);
    const verifierHash = createHash('sha256').update(form.get('code_verifier')!).digest('base64url');
    expect(verifierHash).toBe(url.searchParams.get('code_challenge'));
    expect(form.get('resource')).toBe('https://mcp.stripe.com');
    const row = (await db.query('select status, access_token_enc, tool_count, state_hash from agent.connections')).rows[0];
    expect(row).toMatchObject({ status: 'connected', tool_count: 7, state_hash: null });
    expect(decrypt(row.access_token_enc, ENCRYPTION_KEY)).toBe('team-key');

    const again = await finishConnect(deps(fetchFn), { code: 'code-1', state: url.searchParams.get('state')! }, async () => 7);
    expect(again.ok).toBe(false); // the state works once
  });

  it('shows a cancelled sign-in, and an app that needs a developer app first', async () => {
    const { teamId } = await createTestTeam(db);
    const { fetchFn } = fakeStripe();
    const url = new URL(await startConnect(deps(fetchFn), teamId, 'stripe'));
    const cancelled = await finishConnect(deps(fetchFn), { error: 'access_denied', state: url.searchParams.get('state')! }, async () => 0);
    expect(cancelled).toMatchObject({ ok: false, message: 'The sign-in was cancelled.' });

    await expect(startConnect(deps(fetchFn), teamId, 'hubspot')).rejects.toThrow("HubSpot isn't set up on this installation yet.");
    const apps = await listConnections(deps(fetchFn), teamId);
    expect(apps.map(row => [row.provider, row.available, row.status])).toEqual([
      ['stripe', true, 'failed'],
      ['linear', true, 'not_connected'],
      ['hubspot', false, 'not_connected'],
      ['shopify', false, 'not_connected'],
    ]);
    expect((await listConnections(deps(fetchFn, { HUBSPOT_CLIENT_ID: 'id', HUBSPOT_CLIENT_SECRET: 'secret' }), teamId))[2]!.available).toBe(true);
  });

  it('refreshes a key that is about to expire, and drops an app whose sign-in can no longer be refreshed', async () => {
    const { teamId } = await createTestTeam(db);
    const working = fakeStripe();
    const url = new URL(await startConnect(deps(working.fetchFn), teamId, 'stripe'));
    await finishConnect(deps(working.fetchFn), { code: 'c', state: url.searchParams.get('state')! }, async () => 1);
    await db.query("update agent.connections set expires_at = now() + interval '1 minute'");

    expect(await connectionsForTurn(deps(working.fetchFn), teamId)).toEqual([{ provider: 'stripe', url: 'https://mcp.stripe.com', token: 'fresh-key' }]);

    await db.query("update agent.connections set expires_at = now() + interval '1 minute'");
    const broken = fakeStripe({ refreshFails: true });
    expect(await connectionsForTurn(deps(broken.fetchFn), teamId)).toEqual([]);
    expect((await db.query('select status, error from agent.connections')).rows[0]).toEqual({ status: 'failed', error: 'The sign-in expired. Connect again.' });
  });
});

describe('the sign-in callback', () => {
  it('sends the admin back to Settings → AI agent with how it went', async () => {
    const { fetchFn } = fakeStripe();
    const http = createHttpApp({
      db,
      encryptionKey: ENCRYPTION_KEY,
      enqueueTurn: async () => true,
      healthCheck: async () => undefined,
      apps: { publicUrl: 'https://agent.example.com', env: {}, fetch: fetchFn, publicAppUrl: 'https://app.example.com' },
    });
    expect((await http.request('/connect/callback?state=nope')).status).toBe(400);

    const { teamId } = await createTestTeam(db, { accountId: 4 });
    const url = new URL(await startConnect(deps(fetchFn), teamId, 'stripe'));
    const response = await http.request(`/connect/callback?error=access_denied&state=${url.searchParams.get('state')}`);
    expect(response.status).toBe(302);
    const back = new URL(response.headers.get('location')!);
    expect(back.origin + back.pathname).toBe('https://app.example.com/app/accounts/4/settings/ai-agent');
    expect(Object.fromEntries(back.searchParams)).toEqual({ app: 'stripe', result: 'failed', message: 'The sign-in was cancelled.' });
  });
});
