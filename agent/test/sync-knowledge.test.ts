import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppArticle, AppClient, AppPortal } from '../src/chatwoot.js';
import type { BrainArticle, BrainClient } from '../src/brain.js';
import type { Db } from '../src/db.js';
import { articleUrl, syncKnowledge } from '../src/jobs/sync-knowledge.js';
import { addFile, addWebsite, saveRead } from '../src/sources.js';
import { createTestTeam, ENCRYPTION_KEY, freshDb } from './helpers.js';

let db: Db;

function article(id: number, overrides: Partial<AppArticle> = {}): AppArticle {
  return { id, slug: `article-${id}`, title: `Article ${id}`, content: `Body of ${id}`, status: 'published', updated_at: 1, ...overrides };
}

function fakeApp(portals: AppPortal[], pages: Record<string, AppArticle[][]>): AppClient {
  return {
    getConversation: async () => ({ id: 1, meta: {} }),
    listMessages: async () => [],
    createPrivateNote: async () => undefined,
    openConversation: async () => undefined,
    sendReply: async () => undefined,
    sendVerificationEmail: async () => undefined,
    listPortals: async () => portals,
    listPublishedArticles: async (_account, slug, page) => pages[slug]?.[page - 1] ?? [],
  };
}

function fakeBrain() {
  const sent: Array<{ teamId: string; articles: BrainArticle[] }> = [];
  const brain: BrainClient = {
    runTurn: async () => {
      throw new Error('not used');
    },
    grade: async () => ({ verdict: 'same', reason: '', cost_usd: '0' }),
    putKnowledge: async (teamId, articles) => {
      sent.push({ teamId, articles });
      return { articles: articles.length, pieces: articles.length };
    },
  };
  return { brain, sent };
}

const portal = (slug: string, archived = false): AppPortal => ({ id: 1, slug, name: slug, custom_domain: null, archived });

beforeEach(async () => {
  db ??= await freshDb();
  await db.query('truncate agent.teams restart identity cascade');
});

afterAll(async () => {
  await db?.end();
});

describe('syncKnowledge', () => {
  it('sends every published article from every page of live help centers, with public links', async () => {
    const { teamId } = await createTestTeam(db);
    const app = fakeApp([portal('help'), portal('old', true)], {
      help: [[article(2), article(1)], [article(3, { content: '   ' })]],
      old: [[article(9)]],
    });
    const { brain, sent } = fakeBrain();

    const results = await syncKnowledge({ db, encryptionKey: ENCRYPTION_KEY, appClientFor: () => app, brain, publicAppUrl: 'https://app.example.com' });

    expect(results).toEqual([{ teamId, articles: 2, changed: true }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.teamId).toBe(String(teamId));
    expect(sent[0]!.articles).toEqual([
      { id: '1', title: 'Article 1', body: 'Body of 1', url: 'https://app.example.com/hc/help/articles/article-1' },
      { id: '2', title: 'Article 2', body: 'Body of 2', url: 'https://app.example.com/hc/help/articles/article-2' },
    ]);
  });

  it("sends nothing when the help center didn't change, and again when it did", async () => {
    await createTestTeam(db);
    const pages = { help: [[article(1)]] };
    const { brain, sent } = fakeBrain();
    const deps = { db, encryptionKey: ENCRYPTION_KEY, brain, publicAppUrl: 'https://app.example.com' };

    await syncKnowledge({ ...deps, appClientFor: () => fakeApp([portal('help')], pages) });
    const second = await syncKnowledge({ ...deps, appClientFor: () => fakeApp([portal('help')], pages) });
    expect(second[0]!.changed).toBe(false);
    expect(sent).toHaveLength(1);

    await syncKnowledge({ ...deps, appClientFor: () => fakeApp([portal('help')], { help: [[article(1, { content: 'New body' })]] }) });
    expect(sent).toHaveLength(2);
  });

  it('skips teams that turned the agent off', async () => {
    const { teamId } = await createTestTeam(db);
    await db.query("update agent.teams set mode = 'off' where id = $1", [teamId]);
    const { brain, sent } = fakeBrain();

    const results = await syncKnowledge({ db, encryptionKey: ENCRYPTION_KEY, appClientFor: () => fakeApp([portal('help')], { help: [[article(1)]] }), brain, publicAppUrl: 'https://app.example.com' });

    expect(results).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('builds help center links that are safe for any slug', () => {
    expect(articleUrl('https://app.example.com', 'help desk', 'a/b')).toBe('https://app.example.com/hc/help%20desk/articles/a%2Fb');
  });
});

describe('syncKnowledge with websites and files', () => {
  it('adds the pages read from websites and files after the help center, and syncs only the team asked for', async () => {
    const { teamId } = await createTestTeam(db);
    const other = await createTestTeam(db, { accountId: 2 });
    const website = await addWebsite(db, teamId, 'https://shop.example.com/');
    await saveRead(db, website!.id, [{ url: 'https://shop.example.com/returns', title: 'Returns', body: 'Returns within 30 days.' }]);
    const file = await addFile(db, teamId, { name: 'Care.pdf', type: 'application/pdf', data: Buffer.from('%PDF') });
    await saveRead(db, file.id, [{ url: null, title: 'Caring for linen', body: 'Wash cold.' }]);
    const app = fakeApp([portal('help')], { help: [[article(1)]] });
    const { brain, sent } = fakeBrain();

    await syncKnowledge({ db, encryptionKey: ENCRYPTION_KEY, appClientFor: () => app, brain, publicAppUrl: 'https://app.example.com' }, teamId);

    expect(sent.map(call => call.teamId)).toEqual([String(teamId)]);
    expect(sent[0]!.articles.map(row => [row.id.replace(/\d+$/, 'N'), row.title, row.url])).toEqual([
      ['N', 'Article 1', 'https://app.example.com/hc/help/articles/article-1'],
      ['web-N', 'Returns', 'https://shop.example.com/returns'],
      ['file-N', 'Caring for linen', null],
    ]);
    expect(other.teamId).not.toBe(teamId);
  });
});
