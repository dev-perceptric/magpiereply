// The client for the reader (brain/magpie_reader in this repo): turns a website or a file into plain pages.

export interface ReaderPage {
  url: string | null;
  title: string;
  markdown: string;
}

export interface ReaderClient {
  readWebsite(url: string, maxPages: number): Promise<ReaderPage[]>;
  readFile(file: { name: string; type: string; data: Buffer }): Promise<ReaderPage[]>;
}

// A reader error that says what went wrong in words a teammate can act on ("That address isn't reachable").
export class ReaderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// A 50-page website or a long PDF takes a few minutes.
const READER_TIMEOUT_MS = 15 * 60_000;

async function pagesFrom(response: Response): Promise<ReaderPage[]> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    const detail = typeof body?.detail === 'string' ? body.detail : `The reader answered ${response.status}.`;
    throw new ReaderError(detail, response.status);
  }
  return ((await response.json()) as { pages: ReaderPage[] }).pages;
}

export function createReaderClient(baseUrl: string, apiKey: string): ReaderClient {
  return {
    async readWebsite(url, maxPages) {
      const response = await fetch(new URL('/read/website', baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url, max_pages: maxPages }),
        signal: AbortSignal.timeout(READER_TIMEOUT_MS),
      });
      return pagesFrom(response);
    },
    async readFile(file) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(file.data)], { type: file.type }), file.name);
      const response = await fetch(new URL('/read/file', baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(READER_TIMEOUT_MS),
      });
      return pagesFrom(response);
    },
  };
}
