import { describe, it, expect } from 'vitest';
import { verifyTelegramWebhook, verifySharedSecret } from '@/server/channels/webhookAuth';

// ─── Helper ──────────────────────────────────────────────────

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/webhook', {
    method: 'POST',
    headers,
    body: '{}',
  });
}

// ─── verifyTelegramWebhook ───────────────────────────────────

describe('verifyTelegramWebhook', () => {
  it('accepts when header matches secret', () => {
    const req = makeRequest({ 'x-telegram-bot-api-secret-token': 'abc123' });
    expect(verifyTelegramWebhook(req, 'abc123')).toBe(true);
  });

  it('rejects when header does not match', () => {
    const req = makeRequest({ 'x-telegram-bot-api-secret-token': 'wrong' });
    expect(verifyTelegramWebhook(req, 'abc123')).toBe(false);
  });

  it('rejects when header is missing', () => {
    const req = makeRequest();
    expect(verifyTelegramWebhook(req, 'abc123')).toBe(false);
  });

  it('skips check when secret is empty', () => {
    const req = makeRequest();
    expect(verifyTelegramWebhook(req, '')).toBe(true);
  });
});

// ─── verifySharedSecret ──────────────────────────────────────

describe('verifySharedSecret', () => {
  it('accepts when x-webhook-secret header matches', () => {
    const req = makeRequest({ 'x-webhook-secret': 'my-secret' });
    expect(verifySharedSecret(req, 'my-secret')).toBe(true);
  });

  it('rejects when header does not match', () => {
    const req = makeRequest({ 'x-webhook-secret': 'wrong' });
    expect(verifySharedSecret(req, 'my-secret')).toBe(false);
  });

  it('rejects when header is missing', () => {
    const req = makeRequest();
    expect(verifySharedSecret(req, 'my-secret')).toBe(false);
  });

  it('skips check when expected secret is empty', () => {
    const req = makeRequest();
    expect(verifySharedSecret(req, '')).toBe(true);
  });
});
