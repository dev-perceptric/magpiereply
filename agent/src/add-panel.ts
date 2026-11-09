// Adds the Magpie drafts side panel to a connected account:
//   node dist/add-panel.js --account 1
// Makes a new panel key (only its hash is stored) and adds a "Magpie" Dashboard App to the account, so every
// conversation shows the latest draft beside it. Running it again replaces the key; delete the old app in
// Settings → Integrations → Dashboard apps.
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { createAppAdminClient } from './chatwoot.js';
import { createDb, migrate } from './db.js';
import { hashHookId, newHookId } from './crypto.js';
import { setPanelKeyHash } from './repo.js';

const { values } = parseArgs({ options: { account: { type: 'string' } } });
const accountId = Number(values.account);
if (!Number.isInteger(accountId) || accountId <= 0) {
  console.error('Usage: node dist/add-panel.js --account <id>');
  process.exit(1);
}
const adminToken = process.env.APP_ADMIN_TOKEN;
if (!adminToken) {
  console.error('Set APP_ADMIN_TOKEN to an administrator API key (Profile settings → Access token).');
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
await migrate(db);

const panelKey = newHookId();
const teamId = await setPanelKeyHash(db, accountId, hashHookId(panelKey));
if (teamId === null) {
  console.error(`Account ${accountId} isn't connected yet. Run enable-team first.`);
  await db.end();
  process.exit(1);
}

const admin = createAppAdminClient(config.APP_URL, adminToken);
const app = await admin.createDashboardApp(accountId, { title: 'Magpie', url: new URL(`/panel/${panelKey}`, config.PUBLIC_URL).toString() });
await db.end();
console.log(`Side panel added for team ${teamId} (dashboard app ${app.id}).`);
