// A small client for the MagpieReply app API (the Chatwoot fork). The agent uses its bot key for
// day-to-day work, and an admin key only once, when a team is set up.

export class AppApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface AppMessage {
  id: number;
  content: string | null;
  message_type: number | string;
  private: boolean;
  created_at: number;
  sender?: { id: number; type?: string; name?: string } | null;
}

export interface AppConversation {
  id: number;
  status?: string;
  meta: {
    sender?: { id?: number; name?: string | null; email?: string | null } | null;
    channel?: string | null;
    hmac_verified?: boolean | null;
  };
}

export interface AppPortal {
  id: number;
  slug: string;
  name: string;
  custom_domain: string | null;
  archived: boolean;
}

export interface AppArticle {
  id: number;
  slug: string;
  title: string;
  content: string | null;
  status: string;
  updated_at: number;
}

export interface CreatedBot {
  id: number;
  access_token: string;
  secret: string;
}

export interface AppClient {
  getConversation(accountId: number, conversationId: number): Promise<AppConversation>;
  // The newest messages, or with `before` the ones older than that message id (about 20 at a time).
  listMessages(accountId: number, conversationId: number, before?: number): Promise<AppMessage[]>;
  createPrivateNote(accountId: number, conversationId: number, content: string): Promise<void>;
  // Moves a conversation to Open, so the team sees it. A bot on an inbox files new conversations as Pending.
  openConversation(accountId: number, conversationId: number): Promise<void>;
  // A reply the customer sees. Only ever called when a teammate clicks Send in the side panel.
  sendReply(accountId: number, conversationId: number, content: string): Promise<void>;
  listPortals(accountId: number): Promise<AppPortal[]>;
  listPublishedArticles(accountId: number, portalSlug: string, page: number): Promise<AppArticle[]>;
}

export interface AppAdminClient {
  createAgentBot(accountId: number, bot: { name: string; description: string; outgoingUrl: string }): Promise<CreatedBot>;
  setInboxBot(accountId: number, inboxId: number, botId: number): Promise<void>;
  createDashboardApp(accountId: number, app: { title: string; url: string }): Promise<{ id: number }>;
}

async function request<T>(baseUrl: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { api_access_token: token, 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new AppApiError(`${method} ${path} failed with ${response.status}`, response.status);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function createAppClient(baseUrl: string, botToken: string): AppClient {
  return {
    async getConversation(accountId, conversationId) {
      return request<AppConversation>(baseUrl, botToken, 'GET', `/api/v1/accounts/${accountId}/conversations/${conversationId}`);
    },
    async listMessages(accountId, conversationId, before) {
      const query = before === undefined ? '' : `?before=${before}`;
      const data = await request<{ payload: AppMessage[] }>(
        baseUrl,
        botToken,
        'GET',
        `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages${query}`,
      );
      return data.payload;
    },
    async createPrivateNote(accountId, conversationId, content) {
      await request(baseUrl, botToken, 'POST', `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, {
        content,
        private: true,
        message_type: 'outgoing',
      });
    },
    async openConversation(accountId, conversationId) {
      await request(baseUrl, botToken, 'POST', `/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`, {
        status: 'open',
      });
    },
    async sendReply(accountId, conversationId, content) {
      await request(baseUrl, botToken, 'POST', `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, {
        content,
        private: false,
        message_type: 'outgoing',
      });
    },
    async listPortals(accountId) {
      const data = await request<{ payload: AppPortal[] }>(baseUrl, botToken, 'GET', `/api/v1/accounts/${accountId}/portals`);
      return data.payload;
    },
    async listPublishedArticles(accountId, portalSlug, page) {
      const data = await request<{ payload: AppArticle[] }>(
        baseUrl,
        botToken,
        'GET',
        `/api/v1/accounts/${accountId}/portals/${encodeURIComponent(portalSlug)}/articles?status=published&page=${page}`,
      );
      return data.payload.filter(article => article.status === 'published');
    },
  };
}

export function createAppAdminClient(baseUrl: string, adminToken: string): AppAdminClient {
  return {
    async createAgentBot(accountId, bot) {
      return request<CreatedBot>(baseUrl, adminToken, 'POST', `/api/v1/accounts/${accountId}/agent_bots`, {
        name: bot.name,
        description: bot.description,
        outgoing_url: bot.outgoingUrl,
        bot_type: 'webhook',
      });
    },
    async setInboxBot(accountId, inboxId, botId) {
      await request(baseUrl, adminToken, 'POST', `/api/v1/accounts/${accountId}/inboxes/${inboxId}/set_agent_bot`, {
        agent_bot: botId,
      });
    },
    async createDashboardApp(accountId, app) {
      return request<{ id: number }>(baseUrl, adminToken, 'POST', `/api/v1/accounts/${accountId}/dashboard_apps`, {
        dashboard_app: { title: app.title, content: [{ type: 'frame', url: app.url }] },
      });
    },
  };
}
