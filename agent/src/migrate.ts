import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';

// Runs on deploy before the new version starts (Fly release command).
const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const applied = await migrate(db);
console.log(applied.length ? `[migrate] applied ${applied.join(', ')}` : '[migrate] up to date');
await db.end();
