// Just enough of MCP's Streamable HTTP transport to check a team's app connection: initialize, then list the tools.
// The brain does the real tool calls (brain/magpie_brain/apps.py).

const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 20_000;

export interface McpTool {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean };
}

export class McpError extends Error {}

async function rpc(url: string, token: string, body: unknown, sessionId: string | null, fetchFn: typeof fetch) {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) throw new McpError('The app refused the sign-in.');
  if (!response.ok && response.status !== 202) throw new McpError(`The app answered ${response.status}.`);
  const text = await response.text();
  // A JSON answer, or server-sent events whose data lines carry the answer.
  const payload = (response.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .filter(Boolean)
        .pop()
    : text;
  return { sessionId: response.headers.get('mcp-session-id') ?? sessionId, message: payload ? (JSON.parse(payload) as { result?: any; error?: { message?: string } }) : null };
}

export async function listTools(url: string, token: string, fetchFn: typeof fetch = fetch): Promise<McpTool[]> {
  const init = await rpc(
    url,
    token,
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'MagpieReply', version: '1' } } },
    null,
    fetchFn,
  );
  if (init.message?.error) throw new McpError(init.message.error.message ?? 'The app refused to start.');
  await rpc(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId, fetchFn);
  const listed = await rpc(url, token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.sessionId, fetchFn);
  if (listed.message?.error) throw new McpError(listed.message.error.message ?? "The app wouldn't list its tools.");
  return (listed.message?.result?.tools ?? []) as McpTool[];
}
