import type { Db } from './db.js';

// Websites and files a team gives Magpie to read, and the pages the reader found in them.

export const MAX_WEBSITES = 5;
export const MAX_FILES = 50;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface KnowledgeSource {
  id: number;
  teamId: number;
  kind: 'website' | 'file';
  url: string | null;
  fileName: string | null;
  status: 'reading' | 'ready' | 'failed';
  error: string | null;
  pages: number;
  readAt: string | null;
}

interface SourceRow {
  id: string;
  team_id: string;
  kind: KnowledgeSource['kind'];
  url: string | null;
  file_name: string | null;
  status: KnowledgeSource['status'];
  error: string | null;
  pages: number;
  read_at: Date | null;
}

const SOURCE_COLUMNS = 'id, team_id, kind, url, file_name, status, error, pages, read_at';

function toSource(row: SourceRow): KnowledgeSource {
  return {
    id: Number(row.id),
    teamId: Number(row.team_id),
    kind: row.kind,
    url: row.url,
    fileName: row.file_name,
    status: row.status,
    error: row.error,
    pages: row.pages,
    readAt: row.read_at ? row.read_at.toISOString() : null,
  };
}

export async function listSources(db: Db, teamId: number): Promise<KnowledgeSource[]> {
  const result = await db.query<SourceRow>(`select ${SOURCE_COLUMNS} from agent.knowledge_sources where team_id = $1 order by id`, [teamId]);
  return result.rows.map(toSource);
}

export async function findSource(db: Db, sourceId: number): Promise<KnowledgeSource | null> {
  const result = await db.query<SourceRow>(`select ${SOURCE_COLUMNS} from agent.knowledge_sources where id = $1`, [sourceId]);
  return result.rows[0] ? toSource(result.rows[0]) : null;
}

export async function countSources(db: Db, teamId: number, kind: KnowledgeSource['kind']): Promise<number> {
  const result = await db.query<{ count: string }>('select count(*) from agent.knowledge_sources where team_id = $1 and kind = $2', [
    teamId,
    kind,
  ]);
  return Number(result.rows[0]!.count);
}

// Returns null when the team already has this website.
export async function addWebsite(db: Db, teamId: number, url: string): Promise<KnowledgeSource | null> {
  const result = await db.query<SourceRow>(
    `insert into agent.knowledge_sources (team_id, kind, url) values ($1, 'website', $2)
     on conflict (team_id, url) where kind = 'website' do nothing returning ${SOURCE_COLUMNS}`,
    [teamId, url],
  );
  return result.rows[0] ? toSource(result.rows[0]) : null;
}

export async function addFile(db: Db, teamId: number, file: { name: string; type: string; data: Buffer }): Promise<KnowledgeSource> {
  const result = await db.query<SourceRow>(
    `insert into agent.knowledge_sources (team_id, kind, file_name, file_type, file_data) values ($1, 'file', $2, $3, $4)
     returning ${SOURCE_COLUMNS}`,
    [teamId, file.name, file.type, file.data],
  );
  return toSource(result.rows[0]!);
}

export async function fileOf(db: Db, sourceId: number): Promise<{ name: string; type: string; data: Buffer } | null> {
  const result = await db.query<{ file_name: string; file_type: string | null; file_data: Buffer | null }>(
    'select file_name, file_type, file_data from agent.knowledge_sources where id = $1',
    [sourceId],
  );
  const row = result.rows[0];
  return row?.file_data ? { name: row.file_name, type: row.file_type ?? 'application/octet-stream', data: row.file_data } : null;
}

// Deletes the source and its pages. Returns false when it isn't this team's.
export async function removeSource(db: Db, teamId: number, sourceId: number): Promise<boolean> {
  const result = await db.query('delete from agent.knowledge_sources where id = $1 and team_id = $2', [sourceId, teamId]);
  return (result.rowCount ?? 0) > 0;
}

export async function markReading(db: Db, teamId: number, sourceId: number): Promise<boolean> {
  const result = await db.query("update agent.knowledge_sources set status = 'reading', error = null where id = $1 and team_id = $2", [
    sourceId,
    teamId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

export interface ReadPage {
  url: string | null;
  title: string;
  body: string;
}

// Swaps in what the reader found. A file's bytes are dropped once it has been read.
export async function saveRead(db: Db, sourceId: number, pages: ReadPage[]): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query('delete from agent.knowledge_documents where source_id = $1', [sourceId]);
    for (const page of pages) {
      await client.query('insert into agent.knowledge_documents (source_id, url, title, body) values ($1, $2, $3, $4)', [
        sourceId,
        page.url,
        page.title,
        page.body,
      ]);
    }
    await client.query(
      "update agent.knowledge_sources set status = 'ready', error = null, pages = $2, read_at = now(), file_data = null where id = $1",
      [sourceId, pages.length],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

// Keeps the pages from the last good read, so a website that's down for a day doesn't drop out of Magpie's answers.
export async function saveReadFailure(db: Db, sourceId: number, error: string): Promise<void> {
  await db.query("update agent.knowledge_sources set status = 'failed', error = $2 where id = $1", [sourceId, error.slice(0, 300)]);
}

export interface KnowledgeDocument {
  id: number;
  kind: KnowledgeSource['kind'];
  url: string | null;
  title: string;
  body: string;
}

export async function listDocuments(db: Db, teamId: number): Promise<KnowledgeDocument[]> {
  const result = await db.query<{ id: string; kind: KnowledgeSource['kind']; url: string | null; title: string; body: string }>(
    `select d.id, s.kind, d.url, d.title, d.body from agent.knowledge_documents d
     join agent.knowledge_sources s on s.id = d.source_id
     where s.team_id = $1 order by d.id`,
    [teamId],
  );
  return result.rows.map(row => ({ id: Number(row.id), kind: row.kind, url: row.url, title: row.title, body: row.body }));
}

// Websites last read more than a day ago, for teams the agent works for.
export async function websitesDueForRead(db: Db): Promise<Array<{ id: number; teamId: number }>> {
  const result = await db.query<{ id: string; team_id: string }>(
    `select s.id, s.team_id from agent.knowledge_sources s join agent.teams t on t.id = s.team_id
     where s.kind = 'website' and t.mode <> 'off'
       and (s.read_at is null or s.read_at < now() - interval '20 hours')
     order by s.id`,
  );
  return result.rows.map(row => ({ id: Number(row.id), teamId: Number(row.team_id) }));
}
