import { z } from 'zod';

// Every setting the service needs, read once at start. A missing or invalid value stops the
// process with a clear message instead of failing later on the first request.
const ConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(8080),
  // Where the MagpieReply app's API lives, for example https://app.magpiereply.com
  APP_URL: z.string().url(),
  // Where people reach the app, for help center links in answers and the side panel's frame check.
  // Defaults to APP_URL, which is right whenever the app's API address is also its public one.
  APP_PUBLIC_URL: z.string().url().optional(),
  // This service's own public address, used in the webhook URL given to the app.
  PUBLIC_URL: z.string().url(),
  // 32 random bytes, base64. Encrypts bot keys and signing secrets at rest.
  ENCRYPTION_KEY: z
    .string()
    .refine(value => Buffer.from(value, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
  // Seconds to wait after a customer message before answering, so a burst becomes one turn.
  TURN_DELAY_SECONDS: z.coerce.number().int().min(0).default(4),
  // Shared with the app, for its Settings → AI agent page (src/internal.ts). Without it those routes are off.
  INTERNAL_API_KEY: z.string().min(32).optional(),
  // The brain (brain/ in this repo). Without it, turns only post a "received" note, as in week 1.
  BRAIN_URL: z.string().url().optional(),
  BRAIN_API_KEY: z.string().min(20).optional(),
  // The reader (brain/magpie_reader): websites and files. Without it, Magpie knows only the help center.
  READER_URL: z.string().url().optional(),
  READER_API_KEY: z.string().min(20).optional(),
}).refine(config => Boolean(config.BRAIN_URL) === Boolean(config.BRAIN_API_KEY), {
  message: 'set BRAIN_URL and BRAIN_API_KEY together',
  path: ['BRAIN_URL'],
}).refine(config => Boolean(config.READER_URL) === Boolean(config.READER_API_KEY), {
  message: 'set READER_URL and READER_API_KEY together',
  path: ['READER_URL'],
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${problems.join('\n')}`);
  }
  return parsed.data;
}
