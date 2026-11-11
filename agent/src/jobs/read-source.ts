import type { Db } from '../db.js';
import { ReaderError, type ReaderClient } from '../reader.js';
import { fileOf, findSource, saveRead, saveReadFailure } from '../sources.js';

// Pages per website. Enough for a store's help and policy pages, small enough to read in a few minutes.
export const WEBSITE_MAX_PAGES = 50;
// A page or file with less text than this is almost always a menu or an empty page.
const MIN_PAGE_CHARS = 80;

export interface ReadDeps {
  db: Db;
  reader: ReaderClient;
  // Tells the sync job to send this team's knowledge to the brain again.
  syncTeam: (teamId: number) => Promise<void>;
}

// Reads one website or file with the reader and saves its pages. A problem the team can fix (a bad address, a file
// with no text) marks the source failed for them to see; anything else is thrown so the queue tries again.
export async function readSource(deps: ReadDeps, sourceId: number, finalTry: boolean): Promise<void> {
  const source = await findSource(deps.db, sourceId);
  if (!source) return; // deleted while waiting

  try {
    let pages;
    if (source.kind === 'website') {
      pages = await deps.reader.readWebsite(source.url!, WEBSITE_MAX_PAGES);
    } else {
      const file = await fileOf(deps.db, sourceId);
      if (!file) return; // already read; a file is read once
      pages = await deps.reader.readFile(file);
    }
    const kept = pages
      .map(page => ({ url: page.url, title: page.title.trim() || source.fileName || source.url || 'Untitled', body: page.markdown.trim() }))
      .filter(page => page.body.length >= MIN_PAGE_CHARS);
    if (kept.length === 0) {
      await saveReadFailure(deps.db, sourceId, source.kind === 'website' ? 'No pages with text were found.' : 'No text was found in this file.');
      return;
    }
    await saveRead(deps.db, sourceId, kept);
    await deps.syncTeam(source.teamId);
  } catch (error) {
    const teamCanFix = error instanceof ReaderError && error.status >= 400 && error.status < 500;
    if (teamCanFix || finalTry) {
      await saveReadFailure(deps.db, sourceId, teamCanFix ? error.message : "Couldn't read this right now. Try again later.");
      if (teamCanFix) return;
    }
    throw error;
  }
}
