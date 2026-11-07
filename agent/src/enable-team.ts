// Connects a MagpieReply account to Magpie AI:
//   node dist/enable-team.js --account 1 --inboxes 3,4 --name "Acme"   (or: npm run enable-team -- ...)
// Asks for an admin API key (Profile settings → Access token), creates the agent bot in the
// account, attaches it to the inboxes and stores the bot's key and signing secret encrypted.
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { createAppAdminClient } from './chatwoot.js';
import { createDb, migrate } from './db.js';
import { encrypt, hashHookId, newHookId } from './crypto.js';
import { enableInbox, upsertTeam } from './repo.js';

const { values } = parseArgs({
  options: {
    account: { type: 'string' },
    inboxes: { type: 'string' },
    name: { type: 'string' },
  },
});

const accountId = Number(values.account);
const inboxIds = (values.inboxes ?? '').split(',').filter(Boolean).map(Number);
if (!Number.isInteger(accountId) || accountId <= 0 || inboxIds.length === 0 || inboxIds.some(id => !Number.isInteger(id))) {
  console.error('Usage: node dist/enable-team.js --account <id> --inboxes <id,id> [--name <team name>]');
  process.exit(1);
}

const config = loadConfig();
const adminToken = process.env.APP_ADMIN_TOKEN ?? (await askHidden('Admin API key: '));
const admin = createAppAdminClient(config.APP_URL, adminToken);

const hookId = newHookId();
const bot = await admin.createAgentBot(accountId, {
  name: 'Magpie AI',
  description: 'MagpieReply AI agent',
  outgoingUrl: new URL(`/hooks/chatwoot/${hookId}`, config.PUBLIC_URL).toString(),
});
if (!bot.access_token || !bot.secret) {
  throw new Error('The app did not return the bot key and secret. Use an administrator API key.');
}

const db = createDb(config.DATABASE_URL);
await migrate(db);
const teamId = await upsertTeam(db, {
  accountId,
  name: values.name ?? `Account ${accountId}`,
  hookIdHash: hashHookId(hookId),
  botId: bot.id,
  botTokenEnc: encrypt(bot.access_token, config.ENCRYPTION_KEY),
  botSecretEnc: encrypt(bot.secret, config.ENCRYPTION_KEY),
});

for (const inboxId of inboxIds) {
  await admin.setInboxBot(accountId, inboxId, bot.id);
  await enableInbox(db, teamId, inboxId);
}
await db.end();
console.log(`Team ${teamId} connected: bot ${bot.id} on inboxes ${inboxIds.join(', ')} (mode: draft).`);

async function askHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Hide what's typed so the key doesn't show on screen or in scrollback.
  const output = rl as unknown as { _writeToOutput: (text: string) => void; output: NodeJS.WriteStream };
  output._writeToOutput = text => {
    if (text.includes(question)) output.output.write(question);
  };
  const answer = await rl.question(question);
  rl.close();
  process.stdout.write('\n');
  return answer.trim();
}
