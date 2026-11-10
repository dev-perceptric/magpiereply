import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { encrypt, hashHookId, newHookId } from './crypto.js';
import type { Db } from './db.js';
import { getAccountState, setAccountSettings, setPanelKeyHash, upsertTeam } from './repo.js';

// The app's side door into the agent: MagpieReply's Settings → AI agent page turns the agent on and off through
// these routes. Only the app calls them, on the servers' private network, with the shared INTERNAL_API_KEY.

export interface InternalDeps {
  db: Db;
  encryptionKey: string;
  internalApiKey: string;
  // This service's public address, for the webhook and panel URLs it hands back.
  publicUrl: string;
}

const AccountId = z.coerce.number().int().positive();
const ConnectBody = z.object({
  name: z.string().trim().min(1).max(200),
  bot_id: z.number().int().positive(),
  bot_token: z.string().min(1),
  bot_secret: z.string().min(1),
});
const SettingsBody = z.object({
  mode: z.enum(['off', 'draft']),
  inbox_ids: z.array(z.number().int().positive()).max(500),
});

function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createInternalRoutes(deps: InternalDeps): Hono {
  const internal = new Hono();

  internal.use('*', async (c, next) => {
    if (!sameKey(c.req.header('authorization') ?? '', `Bearer ${deps.internalApiKey}`)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  internal.get('/accounts/:accountId', async c => {
    const accountId = AccountId.safeParse(c.req.param('accountId'));
    if (!accountId.success) return c.json({ error: 'invalid account' }, 422);
    const state = await getAccountState(deps.db, accountId.data);
    if (!state) return c.json({ connected: false, mode: 'off', inbox_ids: [] });
    return c.json({ connected: true, mode: state.mode, inbox_ids: state.inboxIds });
  });

  // Stores the account's agent bot and gives back fresh webhook and panel addresses for the app to save.
  // Connecting again replaces both, so a leaked address stops working once the app reconnects.
  internal.post('/accounts/:accountId/connect', async c => {
    const accountId = AccountId.safeParse(c.req.param('accountId'));
    const body = ConnectBody.safeParse(await c.req.json().catch(() => null));
    if (!accountId.success || !body.success) return c.json({ error: 'invalid request' }, 422);

    const hookId = newHookId();
    const panelKey = newHookId();
    const teamId = await upsertTeam(deps.db, {
      accountId: accountId.data,
      name: body.data.name,
      hookIdHash: hashHookId(hookId),
      botId: body.data.bot_id,
      botTokenEnc: encrypt(body.data.bot_token, deps.encryptionKey),
      botSecretEnc: encrypt(body.data.bot_secret, deps.encryptionKey),
    });
    await setPanelKeyHash(deps.db, accountId.data, hashHookId(panelKey));
    return c.json({
      team_id: teamId,
      hook_url: new URL(`/hooks/chatwoot/${hookId}`, deps.publicUrl).toString(),
      panel_url: new URL(`/panel/${panelKey}`, deps.publicUrl).toString(),
    });
  });

  internal.put('/accounts/:accountId', async c => {
    const accountId = AccountId.safeParse(c.req.param('accountId'));
    const body = SettingsBody.safeParse(await c.req.json().catch(() => null));
    if (!accountId.success || !body.success) return c.json({ error: 'invalid request' }, 422);
    const state = await getAccountState(deps.db, accountId.data);
    if (!state) return c.json({ error: 'not connected' }, 409);
    await setAccountSettings(deps.db, state.teamId, { mode: body.data.mode, inboxIds: body.data.inbox_ids });
    const updated = await getAccountState(deps.db, accountId.data);
    return c.json({ connected: true, mode: updated!.mode, inbox_ids: updated!.inboxIds });
  });

  return internal;
}
