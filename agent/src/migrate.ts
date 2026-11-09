import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';

// Runs the agent migrations by hand. The api and worker also run them when they start.
const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const applied = await migrate(db);
console.log(applied.length ? `[migrate] applied ${applied.join(', ')}` : '[migrate] up to date');
await db.end();
