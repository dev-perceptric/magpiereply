import { createHash } from 'node:crypto';
import type { AppClient } from '../chatwoot.js';
import type { BrainArticle, BrainClient } from '../brain.js';
import { decrypt } from '../crypto.js';
import type { Db } from '../db.js';
import { listActiveTeams, saveKnowledgeHash, type ActiveTeam } from '../repo.js';
import { listDocuments } from '../sources.js';

// A help center rarely has more than a few hundred articles; this stops a runaway loop on a broken page count.
const MAX_PAGES = 200;

export interface SyncDeps {
  db: Db;
  encryptionKey: string;
  appClientFor: (botToken: string) => AppClient;
  brain: BrainClient;
  // Where customers read the help center, for article links in answers.
  publicAppUrl: string;
}

// Gives the brain everything each team's Magpie should know: every published article of its help centers, plus
// the pages read from its websites and files. Sends nothing when nothing changed, so the brain doesn't re-read
// (and pay for) the same text. With a team id, only that team (after one of its websites or files was read).
export async function syncKnowledge(deps: SyncDeps, onlyTeamId?: number): Promise<Array<{ teamId: number; articles: number; changed: boolean }>> {
  const results = [];
  for (const team of await listActiveTeams(deps.db)) {
    if (onlyTeamId !== undefined && team.id !== onlyTeamId) continue;
    results.push(await syncTeam(deps, team));
  }
  return results;
}

export async function syncTeam(deps: SyncDeps, team: ActiveTeam): Promise<{ teamId: number; articles: number; changed: boolean }> {
  const app = deps.appClientFor(decrypt(team.botTokenEnc, deps.encryptionKey));
  const articles: BrainArticle[] = [];
  for (const portal of await app.listPortals(team.accountId)) {
    if (portal.archived) continue;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const found = await app.listPublishedArticles(team.accountId, portal.slug, page);
      if (found.length === 0) break;
      for (const article of found) {
        if (!article.content?.trim()) continue;
        articles.push({
          id: String(article.id),
          title: article.title,
          body: article.content,
          url: articleUrl(deps.publicAppUrl, portal.slug, article.slug),
        });
      }
    }
  }
  articles.sort((first, second) => Number(first.id) - Number(second.id));
  for (const document of await listDocuments(deps.db, team.id)) {
    articles.push({ id: `${document.kind === 'website' ? 'web' : 'file'}-${document.id}`, title: document.title, body: document.body, url: document.url });
  }

  const hash = createHash('sha256').update(JSON.stringify(articles)).digest('hex');
  if (hash === team.knowledgeHash) return { teamId: team.id, articles: articles.length, changed: false };

  await deps.brain.putKnowledge(String(team.id), articles);
  await saveKnowledgeHash(deps.db, team.id, hash);
  return { teamId: team.id, articles: articles.length, changed: true };
}

export function articleUrl(publicAppUrl: string, portalSlug: string, articleSlug: string): string {
  return new URL(`/hc/${encodeURIComponent(portalSlug)}/articles/${encodeURIComponent(articleSlug)}`, publicAppUrl).toString();
}
