import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

// AES-256-GCM. Output is base64 of iv | tag | ciphertext.
export function encrypt(plainText: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function decrypt(encoded: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const data = Buffer.from(encoded, 'base64');
  const iv = data.subarray(0, IV_BYTES);
  const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encrypted = data.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// A long random value for the team's webhook address. Only its hash is stored.
export function newHookId(): string {
  return randomBytes(32).toString('base64url');
}

export function hashHookId(hookId: string): string {
  return createHash('sha256').update(hookId).digest('hex');
}

const MAX_SIGNATURE_AGE_SECONDS = 300;

// The app signs each bot webhook: X-Chatwoot-Signature = "sha256=" + HMAC-SHA256(secret, "<timestamp>.<body>").
export function verifyWebhookSignature(options: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  body: string;
  nowSeconds?: number;
}): boolean {
  const { secret, timestamp, signature, body } = options;
  if (!timestamp || !signature?.startsWith('sha256=')) return false;

  const sentAt = Number(timestamp);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > MAX_SIGNATURE_AGE_SECONDS) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const received = signature.slice('sha256='.length);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}
