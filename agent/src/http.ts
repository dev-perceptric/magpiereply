import { Hono } from 'hono';
import type { Db } from './db.js';
import { decrypt, hashHookId, verifyWebhookSignature } from './crypto.js';
import { findTeamByHookHash, isInboxEnabled, saveEvent } from './repo.js';
import { createPanelRoutes, type PanelDeps } from './panel.js';

// What the app sends for a new message (only the fields we use).
interface MessageEvent {
  event?: string;
  id?: number;
  message_type?: string;
  private?: boolean;
  account?: { id?: number };
  inbox?: { id?: number };
  conversation?: { id?: number };
}

export interface HttpDeps {
  db: Db;
  encryptionKey: string;
  // Queues a turn; returns false when one is already waiting for this conversation.
  enqueueTurn: (job: { teamId: number; conversationId: number }) => Promise<boolean>;
  healthCheck: () => Promise<void>;
  // The drafts side panel; left out where it isn't needed (the webhook tests).
  panel?: Omit<PanelDeps, 'db' | 'encryptionKey'>;
}

// A new customer message we should answer. Everything else is acknowledged and ignored.
function isCustomerMessage(event: MessageEvent): boolean {
  return (
    event.event === 'message_created' &&
    event.message_type === 'incoming' &&
    event.private !== true &&
    typeof event.id === 'number' &&
    typeof event.conversation?.id === 'number' &&
    typeof event.inbox?.id === 'number'
  );
}

export function createHttpApp(deps: HttpDeps): Hono {
  const app = new Hono();

  app.get('/health', async c => {
    try {
      await deps.healthCheck();
      return c.json({ status: 'ok' });
    } catch {
      return c.json({ status: 'unavailable' }, 503);
    }
  });

  app.post('/hooks/chatwoot/:hookId', async c => {
    const team = await findTeamByHookHash(deps.db, hashHookId(c.req.param('hookId')));
    if (!team) return c.json({ error: 'not found' }, 404);

    const body = await c.req.text();
    const signed = verifyWebhookSignature({
      secret: decrypt(team.botSecretEnc, deps.encryptionKey),
      timestamp: c.req.header('x-chatwoot-timestamp'),
      signature: c.req.header('x-chatwoot-signature'),
      body,
    });
    if (!signed) return c.json({ error: 'invalid signature' }, 401);

    let event: MessageEvent;
    try {
      event = JSON.parse(body) as MessageEvent;
    } catch {
      return c.json({ error: 'invalid body' }, 400);
    }

    if (event.account?.id !== team.accountId) return c.json({ error: 'wrong account' }, 403);
    if (team.mode === 'off' || !isCustomerMessage(event)) return c.json({ status: 'ignored' });
    if (!(await isInboxEnabled(deps.db, team.id, event.inbox!.id!))) return c.json({ status: 'ignored' });

    const conversationId = event.conversation!.id!;
    const isNew = await saveEvent(deps.db, {
      teamId: team.id,
      kind: 'message_created',
      messageId: event.id!,
      conversationId,
      deliveryId: c.req.header('x-chatwoot-delivery'),
      payload: event,
    });
    if (!isNew) return c.json({ status: 'duplicate' });

    const queued = await deps.enqueueTurn({ teamId: team.id, conversationId });
    return c.json({ status: queued ? 'queued' : 'already queued' });
  });

  if (deps.panel) {
    app.route('/panel', createPanelRoutes({ db: deps.db, encryptionKey: deps.encryptionKey, ...deps.panel }));
  }

  return app;
}
