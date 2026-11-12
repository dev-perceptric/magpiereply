import { createHash, randomBytes } from 'node:crypto';
import { decrypt, encrypt, hashHookId } from './crypto.js';
import type { Db } from './db.js';

// The apps a team can connect, each through its own MCP server. Stripe and Linear let any app register itself, so
// they work with no setup. HubSpot and Shopify need an app made in their developer dashboards first; their client
// id and secret come from the environment.

export type Provider = 'stripe' | 'linear' | 'hubspot' | 'shopify';

export interface ProviderInfo {
  name: string;
  mcpUrl: string;
  scope: string;
  // Set when the app has no self-registration and needs a client from its developer dashboard.
  clientFromEnv?: { id: string; secret: string };
}

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  stripe: { name: 'Stripe', mcpUrl: 'https://mcp.stripe.com', scope: 'mcp' },
  linear: { name: 'Linear', mcpUrl: 'https://mcp.linear.app/mcp', scope: 'read' },
  hubspot: { name: 'HubSpot', mcpUrl: 'https://mcp.hubspot.com', scope: '', clientFromEnv: { id: 'HUBSPOT_CLIENT_ID', secret: 'HUBSPOT_CLIENT_SECRET' } },
  shopify: { name: 'Shopify', mcpUrl: 'https://mcp.shopify.com/mcp', scope: '', clientFromEnv: { id: 'SHOPIFY_CLIENT_ID', secret: 'SHOPIFY_CLIENT_SECRET' } },
};

export function isProvider(value: string): value is Provider {
  return Object.hasOwn(PROVIDERS, value);
}

// A sign-in that isn't finished in this long has to start again.
const SIGN_IN_MINUTES = 15;
// Keys are refreshed when they have less than this left.
const REFRESH_MARGIN_MS = 5 * 60_000;
const HTTP_TIMEOUT_MS = 15_000;

export interface AuthServer {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
}

export interface AppsDeps {
  db: Db;
  encryptionKey: string;
  // This service's public address; the providers send people back to /connect/callback on it.
  publicUrl: string;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

export class AppError extends Error {}

async function getJson<T>(deps: AppsDeps, url: string): Promise<T | null> {
  const response = await (deps.fetch ?? fetch)(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as T | null;
}

function wellKnown(base: string, name: string): string {
  const url = new URL(base);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `${url.origin}/.well-known/${name}${path}`;
}

// MCP's discovery: the server names its sign-in server, which describes itself (RFC 9728, then RFC 8414).
export async function discover(deps: AppsDeps, provider: Provider): Promise<{ resource: string; server: AuthServer }> {
  const mcpUrl = PROVIDERS[provider].mcpUrl;
  const resourceMeta =
    (await getJson<{ resource?: string; authorization_servers?: string[] }>(deps, wellKnown(mcpUrl, 'oauth-protected-resource'))) ??
    (await getJson<{ resource?: string; authorization_servers?: string[] }>(deps, `${new URL(mcpUrl).origin}/.well-known/oauth-protected-resource`));
  const issuer = resourceMeta?.authorization_servers?.[0] ?? new URL(mcpUrl).origin;
  for (const candidate of [wellKnown(issuer, 'oauth-authorization-server'), `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`, wellKnown(new URL(mcpUrl).origin, 'oauth-authorization-server')]) {
    const server = await getJson<AuthServer>(deps, candidate);
    if (server?.authorization_endpoint && server.token_endpoint) return { resource: resourceMeta?.resource ?? mcpUrl, server };
  }
  throw new AppError(`${PROVIDERS[provider].name} didn't describe its sign-in.`);
}

export function callbackUrl(deps: AppsDeps): string {
  return new URL('/connect/callback', deps.publicUrl).toString();
}

// Whether the app can be connected here: self-registration, or a client from the environment.
export function configured(deps: AppsDeps, provider: Provider): boolean {
  const fromEnv = PROVIDERS[provider].clientFromEnv;
  return !fromEnv || Boolean(deps.env[fromEnv.id] && deps.env[fromEnv.secret]);
}

async function clientFor(deps: AppsDeps, provider: Provider, server: AuthServer): Promise<{ id: string; secret: string | null }> {
  const fromEnv = PROVIDERS[provider].clientFromEnv;
  if (fromEnv) {
    const id = deps.env[fromEnv.id];
    const secret = deps.env[fromEnv.secret];
    if (!id || !secret) throw new AppError(`${PROVIDERS[provider].name} isn't set up on this installation yet.`);
    return { id, secret };
  }
  const redirect = callbackUrl(deps);
  const saved = await deps.db.query<{ client_id: string; client_secret_enc: string | null }>(
    'select client_id, client_secret_enc from agent.oauth_clients where provider = $1 and redirect_uri = $2',
    [provider, redirect],
  );
  if (saved.rows[0]) {
    const row = saved.rows[0];
    return { id: row.client_id, secret: row.client_secret_enc ? decrypt(row.client_secret_enc, deps.encryptionKey) : null };
  }
  if (!server.registration_endpoint) throw new AppError(`${PROVIDERS[provider].name} needs an app made in its developer dashboard.`);
  const response = await (deps.fetch ?? fetch)(server.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'MagpieReply',
      redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(PROVIDERS[provider].scope ? { scope: PROVIDERS[provider].scope } : {}),
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => null)) as { client_id?: string; client_secret?: string } | null;
  if (!response.ok || !body?.client_id) throw new AppError(`${PROVIDERS[provider].name} refused to register MagpieReply.`);
  await deps.db.query(
    `insert into agent.oauth_clients (provider, client_id, client_secret_enc, redirect_uri) values ($1, $2, $3, $4)
     on conflict (provider) do update set client_id = excluded.client_id, client_secret_enc = excluded.client_secret_enc,
       redirect_uri = excluded.redirect_uri, created_at = now()`,
    [provider, body.client_id, body.client_secret ? encrypt(body.client_secret, deps.encryptionKey) : null, redirect],
  );
  return { id: body.client_id, secret: body.client_secret ?? null };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

// Starts a sign-in: returns the provider's page where an admin approves MagpieReply. The state in the address ties the
// answer back to this team, and only its hash is stored.
export async function startConnect(deps: AppsDeps, teamId: number, provider: Provider): Promise<string> {
  if (!configured(deps, provider)) throw new AppError(`${PROVIDERS[provider].name} isn't set up on this installation yet.`);
  const { resource, server } = await discover(deps, provider);
  const client = await clientFor(deps, provider, server);
  const state = randomBytes(32).toString('base64url');
  const { verifier, challenge } = pkce();
  await deps.db.query(
    `insert into agent.connections (team_id, provider, status, state_hash, code_verifier_enc, created_at)
     values ($1, $2, 'pending', $3, $4, now())
     on conflict (team_id, provider) do update set state_hash = excluded.state_hash, code_verifier_enc = excluded.code_verifier_enc,
       created_at = now(), error = null,
       status = case when agent.connections.status = 'connected' then 'connected' else 'pending' end`,
    [teamId, provider, hashHookId(state), encrypt(verifier, deps.encryptionKey)],
  );
  const url = new URL(server.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.id,
    redirect_uri: callbackUrl(deps),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource,
    ...(PROVIDERS[provider].scope ? { scope: PROVIDERS[provider].scope } : {}),
  }).toString();
  return url.toString();
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(deps: AppsDeps, server: AuthServer, client: { id: string; secret: string | null }, fields: Record<string, string>): Promise<TokenAnswer> {
  const response = await (deps.fetch ?? fetch)(server.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ ...fields, client_id: client.id, ...(client.secret ? { client_secret: client.secret } : {}) }).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const body = ((await response.json().catch(() => null)) ?? {}) as TokenAnswer;
  if (!response.ok || !body.access_token) throw new AppError(body.error_description ?? body.error ?? `Sign-in failed (${response.status}).`);
  return body;
}

async function saveTokens(deps: AppsDeps, connectionId: number, tokens: TokenAnswer, keepRefresh: string | null): Promise<void> {
  const refresh = tokens.refresh_token ?? keepRefresh;
  await deps.db.query(
    `update agent.connections set status = 'connected', error = null, state_hash = null, code_verifier_enc = null,
       access_token_enc = $2, refresh_token_enc = $3, expires_at = $4, connected_at = coalesce(connected_at, now())
     where id = $1`,
    [
      connectionId,
      encrypt(tokens.access_token!, deps.encryptionKey),
      refresh ? encrypt(refresh, deps.encryptionKey) : null,
      tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
    ],
  );
}

// The provider sends the admin back here with a code. Returns where the admin goes next (the app's settings page).
export async function finishConnect(
  deps: AppsDeps,
  query: { code?: string; state?: string; error?: string },
  testConnection: (provider: Provider, accessToken: string) => Promise<number>,
): Promise<{ accountId: number | null; provider: Provider | null; ok: boolean; message: string }> {
  if (!query.state) return { accountId: null, provider: null, ok: false, message: 'This sign-in link is missing its state.' };
  const found = await deps.db.query<{ id: string; provider: Provider; account_id: string; code_verifier_enc: string; created_at: Date }>(
    `select c.id, c.provider, t.account_id, c.code_verifier_enc, c.created_at from agent.connections c
     join agent.teams t on t.id = c.team_id where c.state_hash = $1`,
    [hashHookId(query.state)],
  );
  const row = found.rows[0];
  if (!row) return { accountId: null, provider: null, ok: false, message: 'This sign-in expired. Start again from Settings.' };
  const accountId = Number(row.account_id);
  const fail = async (message: string) => {
    await deps.db.query(
      "update agent.connections set state_hash = null, code_verifier_enc = null, error = $2, status = case when status = 'connected' then status else 'failed' end where id = $1",
      [row.id, message],
    );
    return { accountId, provider: row.provider, ok: false, message };
  };
  if (Date.now() - row.created_at.getTime() > SIGN_IN_MINUTES * 60_000) return fail('This sign-in expired. Start again.');
  if (query.error || !query.code) return fail(query.error === 'access_denied' ? 'The sign-in was cancelled.' : "The sign-in didn't finish.");

  try {
    const { resource, server } = await discover(deps, row.provider);
    const client = await clientFor(deps, row.provider, server);
    const tokens = await tokenRequest(deps, server, client, {
      grant_type: 'authorization_code',
      code: query.code,
      redirect_uri: callbackUrl(deps),
      code_verifier: decrypt(row.code_verifier_enc, deps.encryptionKey),
      resource,
    });
    const tools = await testConnection(row.provider, tokens.access_token!);
    await saveTokens(deps, Number(row.id), tokens, null);
    await deps.db.query('update agent.connections set tool_count = $2 where id = $1', [row.id, tools]);
    return { accountId, provider: row.provider, ok: true, message: `${PROVIDERS[row.provider].name} is connected.` };
  } catch (error) {
    return fail(error instanceof AppError ? error.message : `${PROVIDERS[row.provider].name} didn't answer. Try again.`);
  }
}

export interface TeamConnection {
  provider: Provider;
  url: string;
  token: string;
}

// The team's connected apps with fresh keys, for one turn. A key that can't be refreshed marks its app failed and is
// left out, so the turn goes on without it.
export async function connectionsForTurn(deps: AppsDeps, teamId: number): Promise<TeamConnection[]> {
  const rows = await deps.db.query<{ id: string; provider: Provider; access_token_enc: string; refresh_token_enc: string | null; expires_at: Date | null }>(
    "select id, provider, access_token_enc, refresh_token_enc, expires_at from agent.connections where team_id = $1 and status = 'connected'",
    [teamId],
  );
  const result: TeamConnection[] = [];
  for (const row of rows.rows) {
    if (!isProvider(row.provider)) continue;
    let token = decrypt(row.access_token_enc, deps.encryptionKey);
    if (row.expires_at && row.expires_at.getTime() - Date.now() < REFRESH_MARGIN_MS) {
      if (!row.refresh_token_enc) {
        await markFailed(deps, Number(row.id), 'The sign-in expired. Connect again.');
        continue;
      }
      try {
        const refreshToken = decrypt(row.refresh_token_enc, deps.encryptionKey);
        const { resource, server } = await discover(deps, row.provider);
        const client = await clientFor(deps, row.provider, server);
        const tokens = await tokenRequest(deps, server, client, { grant_type: 'refresh_token', refresh_token: refreshToken, resource });
        await saveTokens(deps, Number(row.id), tokens, refreshToken);
        token = tokens.access_token!;
      } catch (error) {
        if (error instanceof AppError) {
          await markFailed(deps, Number(row.id), 'The sign-in expired. Connect again.');
          continue;
        }
        throw error; // the provider is down: the queue retries the turn
      }
    }
    result.push({ provider: row.provider, url: PROVIDERS[row.provider].mcpUrl, token });
  }
  return result;
}

async function markFailed(deps: AppsDeps, connectionId: number, error: string): Promise<void> {
  await deps.db.query("update agent.connections set status = 'failed', error = $2 where id = $1", [connectionId, error]);
}

export interface ConnectionRow {
  provider: Provider;
  name: string;
  available: boolean;
  status: 'not_connected' | 'pending' | 'connected' | 'failed';
  error: string | null;
  connectedAt: string | null;
  toolCount: number | null;
}

export async function listConnections(deps: AppsDeps, teamId: number): Promise<ConnectionRow[]> {
  const rows = await deps.db.query<{ provider: Provider; status: ConnectionRow['status']; error: string | null; connected_at: Date | null; tool_count: number | null }>(
    'select provider, status, error, connected_at, tool_count from agent.connections where team_id = $1',
    [teamId],
  );
  const byProvider = new Map(rows.rows.map(row => [row.provider, row]));
  return (Object.keys(PROVIDERS) as Provider[]).map(provider => {
    const row = byProvider.get(provider);
    return {
      provider,
      name: PROVIDERS[provider].name,
      available: configured(deps, provider),
      status: row?.status ?? 'not_connected',
      error: row?.error ?? null,
      connectedAt: row?.connected_at?.toISOString() ?? null,
      toolCount: row?.tool_count ?? null,
    };
  });
}

export async function disconnect(deps: AppsDeps, teamId: number, provider: Provider): Promise<boolean> {
  const result = await deps.db.query('delete from agent.connections where team_id = $1 and provider = $2', [teamId, provider]);
  return (result.rowCount ?? 0) > 0;
}
