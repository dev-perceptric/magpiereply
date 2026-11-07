import { z } from 'zod';

// Every setting the service needs, read once at start. A missing or invalid value stops the
// process with a clear message instead of failing later on the first request.
const ConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(8080),
  // Where the MagpieReply app's API lives, for example https://app.magpiereply.com
  APP_URL: z.string().url(),
  // This service's own public address, used in the webhook URL given to the app.
  PUBLIC_URL: z.string().url(),
  // 32 random bytes, base64. Encrypts bot keys and signing secrets at rest.
  ENCRYPTION_KEY: z
    .string()
    .refine(value => Buffer.from(value, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
  // Seconds to wait after a customer message before answering, so a burst becomes one turn.
  TURN_DELAY_SECONDS: z.coerce.number().int().min(0).default(4),
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
