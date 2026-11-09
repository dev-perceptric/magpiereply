// The client for the brain (brain/ in this repo): one reply from the Magpie engine.

export interface BrainTurnRequest {
  team_id: string;
  customer: { id: string; name: string; email: string | null; verified: boolean };
  // The conversation so far, oldest first, ending with the customer's newest message(s).
  history: Array<{ role: 'customer' | 'agent'; content: string }>;
}

export interface BrainProposal {
  action: string;
  charge_id: string;
  amount: string;
  approval: 'customer_confirms' | 'staff_approves';
}

export interface BrainTurnResult {
  reply: string | null;
  tools: Array<{ name: string; arguments: Record<string, unknown> }>;
  proposals: BrainProposal[];
  handoff: { team: string; reason: string } | null;
  seconds: number;
  cost_usd: string | null;
  tokens: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
}

export interface BrainArticle {
  id: string;
  title: string;
  body: string;
  url: string | null;
}

export interface BrainClient {
  runTurn(request: BrainTurnRequest): Promise<BrainTurnResult>;
  // Replaces everything the brain knows for this team.
  putKnowledge(teamId: string, articles: BrainArticle[]): Promise<{ articles: number; pieces: number }>;
}

export class BrainError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// A reply with tool calls takes a few seconds; anything past a minute is treated as a failure and retried.
const BRAIN_TIMEOUT_MS = 60_000;

export function createBrainClient(baseUrl: string, apiKey: string): BrainClient {
  return {
    async runTurn(request) {
      const response = await fetch(new URL('/magpie/reply', baseUrl), {
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
    async putKnowledge(teamId, articles) {
      const response = await fetch(new URL(`/magpie/knowledge/${encodeURIComponent(teamId)}`, baseUrl), {
        method: 'PUT',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ articles }),
        signal: AbortSignal.timeout(BRAIN_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new BrainError(`brain knowledge update failed with ${response.status}`, response.status);
      }
      return (await response.json()) as { articles: number; pieces: number };
    },
  };
}
