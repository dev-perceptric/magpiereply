// Calls Claude's Messages API. Busy, rate-limited and server errors are tried again with growing waits.
const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_TRIES = 4;

export type AnthropicOptions = { apiKey: string; fetchImpl?: typeof fetch; retryDelayMs?: number };

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export type Message = { role: 'user' | 'assistant'; content: string | ContentBlock[] };

export type MessageResponse = {
  content: ContentBlock[];
  stop_reason: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

function isRetryable(status: number): boolean {
  return status === 429 || status === 529 || status >= 500;
}

export async function createMessage(body: Record<string, unknown>, options: AnthropicOptions): Promise<MessageResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const wait = (attempt: number) => new Promise(resolve => setTimeout(resolve, 2 ** attempt * retryDelayMs));

  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(API_URL, {
        method: 'POST',
        headers: { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (attempt >= MAX_TRIES) throw error;
      await wait(attempt);
      continue;
    }
    if (isRetryable(response.status) && attempt < MAX_TRIES) {
      await wait(attempt);
      continue;
    }
    if (!response.ok) throw new Error(`Claude answered ${response.status}: ${await response.text()}`);
    return (await response.json()) as MessageResponse;
  }
}
