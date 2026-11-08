// The client for the brain (brain/ in this repo): one conversation turn through Parlant.

export interface BrainTurnRequest {
  team_id: string;
  conversation_id: string;
  session_id: string | null;
  customer: { id: string; name: string; email: string | null; verified: boolean };
  messages: Array<{ id: string; content: string }>;
}

export interface BrainProposal {
  action: string;
  charge_id: string;
  amount: string;
  approval: 'customer_confirms' | 'staff_approves';
}

export interface BrainTurnResult {
  session_id: string;
  reply: string | null;
  tools: Array<{ name: string; arguments: Record<string, unknown> }>;
  proposals: BrainProposal[];
  handoff: { team: string; reason: string } | null;
  already_with_people: boolean;
  seconds: number;
  cost_usd: string | null;
  tokens: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
}

export interface BrainClient {
  runTurn(request: BrainTurnRequest): Promise<BrainTurnResult>;
}

export class BrainError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// The brain waits up to 90 seconds for Parlant; allow a little more here.
const BRAIN_TIMEOUT_MS = 120_000;

export function createBrainClient(baseUrl: string, apiKey: string): BrainClient {
  return {
    async runTurn(request) {
      const response = await fetch(new URL('/magpie/turn', baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(BRAIN_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new BrainError(`brain turn failed with ${response.status}`, response.status);
      }
      return (await response.json()) as BrainTurnResult;
    },
  };
}
