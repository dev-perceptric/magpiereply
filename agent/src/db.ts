import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

export type Db = pg.Pool;

export function createDb(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'db', 'migrations');

// Applies each .sql file in db/migrations once, in name order, each in its own transaction.
export async function migrate(db: Db, migrationsDir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query('create schema if not exists agent');
  await db.query(
    'create table if not exists agent.schema_migrations (name text primary key, applied_at timestamptz not null default now())',
  );

  const files = (await readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
  const applied = new Set(
    (await db.query<{ name: string }>('select name from agent.schema_migrations')).rows.map(row => row.name),
  );

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into agent.schema_migrations (name) values ($1)', [file]);
      await client.query('commit');
      newlyApplied.push(file);
    } catch (error) {
      await client.query('rollback');
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}
