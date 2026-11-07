import pg from 'pg';

// Tests run against a real Postgres database, recreated for each run.
// Set TEST_DATABASE_URL, or a local postgres with user postgres/postgres is used.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/magpie_agent_test';

export default async function setup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const database = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`drop database if exists "${database}" with (force)`);
  await admin.query(`create database "${database}"`);
  await admin.end();
}
