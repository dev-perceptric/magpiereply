// Stripe through the team's gateway server, as the trial's setups use it. Every gateway call comes
// back with a tool_call event, so the runner sees exactly what ran.
import type { McpClient, McpTool } from '../../mcp-client.js';
import type { TrialEvent } from '../agent-under-test.js';

export type Payment = {
  id: string;
  amountCents: number;
  date: string;
  description: string;
  metadata: Record<string, string>;
  status: string;
};

type ToolCallEvent = Extract<TrialEvent, { type: 'tool_call' }>;

export interface StripeAccess {
  findCustomerId(email: string): Promise<{ customerId: string | null; call: ToolCallEvent }>;
  listPayments(customerId: string): Promise<{ payments: Payment[]; call: ToolCallEvent }>;
  refund(paymentId: string, amountCents: number): Promise<{ ok: boolean; call: ToolCallEvent }>;
}

// Stripe answers with JSON text: a list, or an object with a `data` list.
function parseList(text: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { data?: unknown })?.data;
  return Array.isArray(list) ? list.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null) : [];
}

export function toPayment(entry: Record<string, unknown>): Payment | null {
  const { id, amount, created, description, metadata, status } = entry;
  if (typeof id !== 'string' || typeof amount !== 'number') return null;
  return {
    id,
    amountCents: amount,
    date: typeof created === 'number' ? new Date(created * 1000).toISOString().slice(0, 10) : 'unknown',
    description: typeof description === 'string' ? description : '',
    metadata: typeof metadata === 'object' && metadata !== null ? (metadata as Record<string, string>) : {},
    status: typeof status === 'string' ? status : 'unknown',
  };
}

function findTool(tools: McpTool[], pattern: RegExp): string {
  const tool = tools.find(entry => pattern.test(entry.name));
  if (!tool) throw new Error(`The gateway has no Stripe tool matching ${pattern}. Tools: ${tools.map(entry => entry.name).join(', ')}`);
  return tool.name;
}

export function createGatewayStripe(mcp: McpClient): StripeAccess {
  let toolNames: Promise<{ customers: string; payments: string; refund: string }> | undefined;
  const names = () =>
    (toolNames ??= mcp.listTools().then(tools => ({
      customers: findTool(tools, /list[_-]customers$/),
      payments: findTool(tools, /list[_-]payment[_-]intents$/),
      refund: findTool(tools, /create[_-]refund$/),
    })));

  async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; call: ToolCallEvent }> {
    try {
      const result = await mcp.callTool(name, args);
      return { text: result.text, call: { type: 'tool_call', name, arguments: args, ok: !result.isError, result: result.text } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { text: '', call: { type: 'tool_call', name, arguments: args, ok: false, result: message } };
    }
  }

  return {
    async findCustomerId(email) {
      const { text, call: event } = await call((await names()).customers, { email, limit: 1 });
      const customer = parseList(text).find(entry => typeof entry.id === 'string' && entry.id.startsWith('cus_'));
      return { customerId: (customer?.id as string | undefined) ?? null, call: event };
    },
    async listPayments(customerId) {
      const { text, call: event } = await call((await names()).payments, { customer: customerId, limit: 20 });
      const payments = parseList(text).map(toPayment).filter((payment): payment is Payment => payment !== null);
      return { payments, call: event };
    },
    async refund(paymentId, amountCents) {
      const { call: event } = await call((await names()).refund, { payment_intent: paymentId, amount: amountCents });
      return { ok: event.ok, call: event };
    },
  };
}

// For runs without a gateway: every call fails, so knowledge cases can run and charge cases show it.
export function createDisconnectedStripe(): StripeAccess {
  const failed = (name: string, args: Record<string, unknown>): ToolCallEvent => ({
    type: 'tool_call',
    name,
    arguments: args,
    ok: false,
    result: 'Stripe is not connected (GATEWAY_MCP_URL is not set)',
  });
  return {
    findCustomerId: async email => ({ customerId: null, call: failed('stripe-list-customers', { email }) }),
    listPayments: async customerId => ({ payments: [], call: failed('stripe-list-payment-intents', { customer: customerId }) }),
    refund: async (paymentId, amountCents) => ({
      ok: false,
      call: failed('stripe-create-refund', { payment_intent: paymentId, amount: amountCents }),
    }),
  };
}
