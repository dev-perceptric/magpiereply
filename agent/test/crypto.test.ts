import { describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { decrypt, encrypt, hashHookId, newHookId, verifyWebhookSignature } from '../src/crypto.js';

const key = randomBytes(32).toString('base64');

describe('encrypt and decrypt', () => {
  it('round-trips a value and never stores it in plain text', () => {
    const encoded = encrypt('bot-api-key', key);
    expect(encoded).not.toContain('bot-api-key');
    expect(decrypt(encoded, key)).toBe('bot-api-key');
  });

  it('rejects a value encrypted with another key', () => {
    const encoded = encrypt('bot-api-key', key);
    expect(() => decrypt(encoded, randomBytes(32).toString('base64'))).toThrow();
  });
});

describe('hook IDs', () => {
  it('are long, random and stored only as a hash', () => {
    const hookId = newHookId();
    expect(hookId.length).toBeGreaterThanOrEqual(40);
    expect(newHookId()).not.toBe(hookId);
    expect(hashHookId(hookId)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'bot-signing-secret';
  const body = '{"event":"message_created"}';
  const now = 1_800_000_000;
  const sign = (timestamp: number, payload = body) =>
    `sha256=${createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')}`;

  it('accepts a fresh, correct signature', () => {
    expect(verifyWebhookSignature({ secret, timestamp: String(now), signature: sign(now), body, nowSeconds: now })).toBe(true);
  });

  it('rejects a changed body', () => {
    expect(
      verifyWebhookSignature({ secret, timestamp: String(now), signature: sign(now), body: '{"event":"x"}', nowSeconds: now }),
    ).toBe(false);
  });

  it('rejects an old timestamp, so a captured request cannot be replayed later', () => {
    const old = now - 301;
    expect(verifyWebhookSignature({ secret, timestamp: String(old), signature: sign(old), body, nowSeconds: now })).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyWebhookSignature({ secret, timestamp: String(now), signature: undefined, body, nowSeconds: now })).toBe(false);
  });
});
