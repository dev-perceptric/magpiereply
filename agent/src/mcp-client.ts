// A small MCP client over Streamable HTTP, for calling a team's tools through the gateway:
// JSON-RPC posts, answered as plain JSON or as an event stream.
export type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
export type McpToolResult = { text: string; isError: boolean };

const PROTOCOL_VERSION = '2025-06-18';

export function createMcpClient(url: string, token: string, fetchImpl: typeof fetch = fetch) {
  let sessionId: string | undefined;
  let nextId = 1;
  let initialized: Promise<void> | undefined;

  async function post(message: { method: string; id?: number; params?: unknown }): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...message }) });
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    const text = await response.text();
    if (!response.ok) throw new Error(`MCP ${message.method} answered ${response.status}: ${text}`);
    if (message.id === undefined) return null;

    const isStream = (response.headers.get('content-type') ?? '').includes('text/event-stream');
    const replies = isStream
      ? text
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => JSON.parse(line.slice(5)) as { id?: number; result?: unknown; error?: unknown })
      : [JSON.parse(text) as { id?: number; result?: unknown; error?: unknown }];
    const reply = replies.find(entry => entry.id === message.id);
    if (!reply) throw new Error(`MCP ${message.method} got no reply`);
    if (reply.error) throw new Error(`MCP ${message.method} failed: ${JSON.stringify(reply.error)}`);
    return reply.result;
  }

  function request(method: string, params: unknown): Promise<unknown> {
    return post({ method, id: nextId++, params });
  }

  function ensureInitialized(): Promise<void> {
    initialized ??= (async () => {
      await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'magpie-agent', version: '1.0.0' },
      });
      await post({ method: 'notifications/initialized' });
    })();
    return initialized;
  }

  return {
    async listTools(): Promise<McpTool[]> {
      await ensureInitialized();
      const result = (await request('tools/list', {})) as { tools: McpTool[] };
      return result.tools;
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
      await ensureInitialized();
      const result = (await request('tools/call', { name, arguments: args })) as {
        content?: { type: string; text?: string }[];
        isError?: boolean;
      };
      const text = (result.content ?? [])
        .filter(part => part.type === 'text')
        .map(part => part.text ?? '')
        .join('\n');
      return { text, isError: result.isError === true };
    },
  };
}

export type McpClient = ReturnType<typeof createMcpClient>;
