import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the unpairChannel logic by mocking external fetch calls
// and the credential store.

describe('unpairChannel', () => {
  const originalEnv = { ...process.env };
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('unpairs telegram: calls deleteWebhook and clears credentials', async () => {
    const { CredentialStore } = await import('@/server/channels/credentials/credentialStore');
    const store = new CredentialStore(':memory:');
    store.setCredential('telegram', 'bot_token', 'test-token');
    store.setCredential('telegram', 'webhook_secret', 'test-secret');

    const { unpairChannel } = await import('@/server/channels/pairing/unpair');
    await unpairChannel('telegram', undefined, store);

    // deleteWebhook should have been called
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/deleteWebhook'),
      expect.objectContaining({ method: 'POST' }),
    );

    // Credentials should be cleared
    expect(store.getCredential('telegram', 'bot_token')).toBeNull();
    expect(store.getCredential('telegram', 'webhook_secret')).toBeNull();
  });

  it('unpairs discord: clears credentials without API call', async () => {
    const { CredentialStore } = await import('@/server/channels/credentials/credentialStore');
    const store = new CredentialStore(':memory:');
    store.setCredential('discord', 'bot_token', 'dc-token');

    const { unpairChannel } = await import('@/server/channels/pairing/unpair');
    await unpairChannel('discord', undefined, store);

    expect(store.getCredential('discord', 'bot_token')).toBeNull();
    // No external API call expected for Discord
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws for unsupported channel', async () => {
    const { unpairChannel } = await import('@/server/channels/pairing/unpair');
    await expect(unpairChannel('signal' as 'telegram')).rejects.toThrow('Unsupported channel');
  });
});
