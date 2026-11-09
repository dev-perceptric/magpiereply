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
  meta: {
    sender?: { id?: number; name?: string | null; email?: string | null } | null;
    channel?: string | null;
    hmac_verified?: boolean | null;
  };
}

export interface CreatedBot {
  id: number;
  access_token: string;
  secret: string;
}

export interface AppClient {
  getConversation(accountId: number, conversationId: number): Promise<AppConversation>;
  listMessages(accountId: number, conversationId: number): Promise<AppMessage[]>;
  createPrivateNote(accountId: number, conversationId: number, content: string): Promise<void>;
}

export interface AppAdminClient {
  createAgentBot(accountId: number, bot: { name: string; description: string; outgoingUrl: string }): Promise<CreatedBot>;
  setInboxBot(accountId: number, inboxId: number, botId: number): Promise<void>;
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
    async listMessages(accountId, conversationId) {
      const data = await request<{ payload: AppMessage[] }>(
        baseUrl,
        botToken,
        'GET',
        `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
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
  };
}
