import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { encrypt, hashHookId, newHookId } from './crypto.js';
import type { Db } from './db.js';
import { findTeam, getAccountState, setAccountSettings, setPanelKeyHash, upsertTeam } from './repo.js';
import { evalCases, listEvalRuns, startReplay } from './jobs/replay.js';
import { autoGate, getFlag, listRuns, runSteps, setMonthlyCap, summaryFor } from './trust.js';
import {
  addFile,
  addWebsite,
  countSources,
  listSources,
  markReading,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_WEBSITES,
  removeSource,
  type KnowledgeSource,
} from './sources.js';

// The app's side door into the agent: MagpieReply's Settings → AI agent page turns the agent on and off through
// these routes. Only the app calls them, on the servers' private network, with the shared INTERNAL_API_KEY.

export interface InternalDeps {
  db: Db;
  encryptionKey: string;
  internalApiKey: string;
  // This service's public address, for the webhook and panel URLs it hands back.
  publicUrl: string;
  // Queue a read of a website or file, and a fresh sync of a team's knowledge to the brain.
  enqueueRead: (sourceId: number) => Promise<void>;
  enqueueSync: (teamId: number) => Promise<void>;
  enqueueReplay: (evalRunId: number) => Promise<void>;
}

// What a file can be: the formats Docling reads, plus plain text and Markdown.
const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  txt: 'text/plain',
};

const WebsiteBody = z.object({
  url: z
    .string()
    .trim()
    .max(2000)
    .refine(value => URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol), 'must start with http or https'),
});

function sourceJson(source: KnowledgeSource) {
  return {
    id: source.id,
    kind: source.kind,
    name: source.kind === 'website' ? source.url : source.fileName,
    status: source.status,
    error: source.error,
    pages: source.pages,
    read_at: source.readAt,
  };
}

const AccountId = z.coerce.number().int().positive();
const ConnectBody = z.object({
  name: z.string().trim().min(1).max(200),
  bot_id: z.number().int().positive(),
  bot_token: z.string().min(1),
  bot_secret: z.string().min(1),
});
const SettingsBody = z.object({
  mode: z.enum(['off', 'draft', 'auto']),
  inbox_ids: z.array(z.number().int().positive()).max(500),
});
const CapBody = z.object({ monthly_cap_usd: z.number().min(0).max(100_000) });

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
    if (body.data.mode === 'auto' && state.mode !== 'auto') {
      const gate = await autoGate(deps.db, state.teamId);
      if (!gate.allowed) return c.json({ error: gate.reason }, 422);
    }
    await setAccountSettings(deps.db, state.teamId, { mode: body.data.mode, inboxIds: body.data.inbox_ids });
    const updated = await getAccountState(deps.db, accountId.data);
    return c.json({ connected: true, mode: updated!.mode, inbox_ids: updated!.inboxIds });
  });

  // Usage this month, how Magpie did in the last 30 days, and whether Auto is open to this team.
  internal.get('/accounts/:accountId/summary', async c => {
    const accountId = AccountId.safeParse(c.req.param('accountId'));
    if (!accountId.success) return c.json({ error: 'invalid account' }, 422);
    const state = await getAccountState(deps.db, accountId.data);
    if (!state) return c.json({ error: 'not connected' }, 409);
    const team = (await findTeam(deps.db, state.teamId))!;
    const summary = await summaryFor(deps.db, team.id, team.monthlyCapUsd);
    const gate = await autoGate(deps.db, team.id);
    const [latestTest] = await listEvalRuns(deps.db, team.id);
    return c.json({
      month: { cost_usd: summary.month.costUsd, cap_usd: summary.month.capUsd, cap_reached: summary.month.capReached },
      last_30_days: summary.last30Days,
      auto: {
        allowed: gate.allowed || state.mode === 'auto',
        reason: state.mode === 'auto' ? null : gate.reason,
        paused: (await getFlag(deps.db, 'auto_paused')) || (await getFlag(deps.db, 'all_paused')),
      },
      latest_test: latestTest ?? null,
    });
  });

  internal.put('/accounts/:accountId/cap', async c => {
    const accountId = AccountId.safeParse(c.req.param('accountId'));
    const body = CapBody.safeParse(await c.req.json().catch(() => null));
    if (!accountId.success || !body.success) return c.json({ error: 'invalid request' }, 422);
    const state = await getAccountState(deps.db, accountId.data);
    if (!state) return c.json({ error: 'not connected' }, 409);
    await setMonthlyCap(deps.db, state.teamId, body.data.monthly_cap_usd);
    return c.json({ monthly_cap_usd: body.data.monthly_cap_usd });
  });

  internal.get('/accounts/:accountId/runs', async c => {
    const accountId = AccountId.safeParse(c.req.param('accountId'));
    const before = c.req.query('before');
    const beforeId = before === undefined ? undefined : AccountId.safeParse(before);
    if (!accountId.success || (beforeId && !beforeId.success)) return c.json({ error: 'invalid request' }, 422);
    const state = await getAccountState(deps.db, accountId.data);
    if (!state) return c.json({ runs: [] });
    return c.json({ runs: await listRuns(deps.db, state.teamId, beforeId?.data) });
  });

  internal.get('/accounts/:accountId/runs/:runId', async c => {
    const accountId = AccountId.safeParse(c.req.param('accountId'));
    const runId = AccountId.safeParse(c.req.param('runId'));
    if (!accountId.success || !runId.success) return c.json({ error: 'invalid request' }, 422);
    const state = await getAccountState(deps.db, accountId.data);
    const found = state ? await runSteps(deps.db, state.teamId, runId.data) : null;
    if (!found) return c.json({ error: 'not found' }, 404);
    return c.json(found);
  });

  internal.get('/accounts/:accountId/tests', async c => {
    const accountId = AccountId.safeParse(c.req.param('accountId'));
    if (!accountId.success) return c.json({ error: 'invalid account' }, 422);
    const state = await getAccountState(deps.db, accountId.data);
    return c.json({ tests: state ? await listEvalRuns(deps.db, state.teamId) : [] });
  });

  internal.post('/accounts/:accountId/tests', async c => {
    const accountId = AccountId.safeParse(c.req.param('accountId'));
    if (!accountId.success) return c.json({ error: 'invalid account' }, 422);
    const state = await getAccountState(deps.db, accountId.data);
    if (!state) return c.json({ error: 'not connected' }, 409);
    const [latest] = await listEvalRuns(deps.db, state.teamId);
    if (latest?.status === 'running') return c.json({ error: 'A replay test is already running.' }, 422);
    const evalRunId = await startReplay(deps.db, state.teamId);
    await deps.enqueueReplay(evalRunId);
    return c.json({ id: evalRunId, status: 'running' }, 201);
  });

  internal.get('/accounts/:accountId/tests/:testId', async c => {
    const accountId = AccountId.safeParse(c.req.param('accountId'));
    const testId = AccountId.safeParse(c.req.param('testId'));
    if (!accountId.success || !testId.success) return c.json({ error: 'invalid request' }, 422);
    const state = await getAccountState(deps.db, accountId.data);
    if (!state) return c.json({ error: 'not found' }, 404);
    return c.json({ cases: await evalCases(deps.db, state.teamId, testId.data) });
  });

  internal.get('/accounts/:accountId/sources', async c => {
    const accountId = AccountId.safeParse(c.req.param('accountId'));
    if (!accountId.success) return c.json({ error: 'invalid account' }, 422);
    const state = await getAccountState(deps.db, accountId.data);
    if (!state) return c.json({ sources: [] });
    return c.json({ sources: (await listSources(deps.db, state.teamId)).map(sourceJson) });
  });

  // A website (JSON with a url) or a file (multipart with a file).
  internal.post('/accounts/:accountId/sources', async c => {
    const accountId = AccountId.safeParse(c.req.param('accountId'));
    if (!accountId.success) return c.json({ error: 'invalid account' }, 422);
    const state = await getAccountState(deps.db, accountId.data);
    if (!state) return c.json({ error: 'not connected' }, 409);

    let source: KnowledgeSource | null;
    if ((c.req.header('content-type') ?? '').startsWith('multipart/form-data')) {
      const form = await c.req.parseBody().catch(() => null);
      const file = form?.file;
      if (!(file instanceof File)) return c.json({ error: 'Choose a file.' }, 422);
      const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (!FILE_TYPES[extension]) return c.json({ error: 'Use a PDF, Word, PowerPoint, Excel, HTML, Markdown or text file.' }, 422);
      if (file.size > MAX_FILE_BYTES) return c.json({ error: 'Files can be up to 20 MB.' }, 422);
      if ((await countSources(deps.db, state.teamId, 'file')) >= MAX_FILES) return c.json({ error: `Up to ${MAX_FILES} files.` }, 422);
      source = await addFile(deps.db, state.teamId, {
        name: file.name.slice(0, 255),
        type: FILE_TYPES[extension]!,
        data: Buffer.from(await file.arrayBuffer()),
      });
    } else {
      const body = WebsiteBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: 'Enter a website address that starts with https://' }, 422);
      if ((await countSources(deps.db, state.teamId, 'website')) >= MAX_WEBSITES) {
        return c.json({ error: `Up to ${MAX_WEBSITES} websites.` }, 422);
      }
      source = await addWebsite(deps.db, state.teamId, new URL(body.data.url).toString());
      if (!source) return c.json({ error: 'That website is already added.' }, 422);
    }
    await deps.enqueueRead(source.id);
    return c.json({ source: sourceJson(source) }, 201);
  });

  internal.post('/accounts/:accountId/sources/:sourceId/read', async c => {
    const accountId = AccountId.safeParse(c.req.param('accountId'));
    const sourceId = AccountId.safeParse(c.req.param('sourceId'));
    if (!accountId.success || !sourceId.success) return c.json({ error: 'invalid request' }, 422);
    const state = await getAccountState(deps.db, accountId.data);
    if (!state || !(await markReading(deps.db, state.teamId, sourceId.data))) return c.json({ error: 'not found' }, 404);
    await deps.enqueueRead(sourceId.data);
    return c.json({ status: 'reading' });
  });

  internal.delete('/accounts/:accountId/sources/:sourceId', async c => {
    const accountId = AccountId.safeParse(c.req.param('accountId'));
    const sourceId = AccountId.safeParse(c.req.param('sourceId'));
    if (!accountId.success || !sourceId.success) return c.json({ error: 'invalid request' }, 422);
    const state = await getAccountState(deps.db, accountId.data);
    if (!state || !(await removeSource(deps.db, state.teamId, sourceId.data))) return c.json({ error: 'not found' }, 404);
    await deps.enqueueSync(state.teamId);
    return c.json({ status: 'removed' });
  });

  return internal;
}
