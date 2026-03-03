import { afterEach, describe, expect, it } from 'vitest';
import { verifyTelegramWebhook, verifySharedSecret } from '@/server/channels/webhookAuth';

// ─── Helper ──────────────────────────────────────────────────

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/webhook', {
    method: 'POST',
    headers,
    body: '{}',
  });
}

afterEach(() => {
  delete process.env.ALLOW_INSECURE_WEBHOOKS;
});

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

  it('fails closed when secret is empty', () => {
    const req = makeRequest();
    expect(verifyTelegramWebhook(req, '')).toBe(false);
  });

  it('allows empty secret only with explicit insecure dev flag', () => {
    process.env.ALLOW_INSECURE_WEBHOOKS = 'true';
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

  it('fails closed when expected secret is empty', () => {
    const req = makeRequest();
    expect(verifySharedSecret(req, '')).toBe(false);
  });

  it('allows empty shared secret only with explicit insecure dev flag', () => {
    process.env.ALLOW_INSECURE_WEBHOOKS = 'true';
    const req = makeRequest();
    expect(verifySharedSecret(req, '')).toBe(true);
  });
});
