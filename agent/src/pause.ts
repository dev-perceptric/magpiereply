// The kill switches, for every team at once. Run in agent-worker:
//   node dist/pause.js auto on    Auto mode acts as Draft mode: nothing goes out without a person
//   node dist/pause.js all on     Magpie stops reading conversations (Auto conversations go to people)
//   node dist/pause.js auto off   back to normal; "all off" likewise
//   node dist/pause.js            shows both switches
import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';
import { getFlag, setFlag, type FlagName } from './trust.js';

const [which, state] = process.argv.slice(2);
const db = createDb(loadConfig().DATABASE_URL);
await migrate(db);
const flags: Record<string, FlagName> = { auto: 'auto_paused', all: 'all_paused' };

if (which) {
  const flag = flags[which];
  if (!flag || !['on', 'off'].includes(state ?? '')) {
    console.error('Usage: node dist/pause.js [auto|all] [on|off]');
    process.exit(1);
  }
  await setFlag(db, flag, state === 'on');
}
console.log(`auto paused: ${await getFlag(db, 'auto_paused')}, all paused: ${await getFlag(db, 'all_paused')}`);
await db.end();
