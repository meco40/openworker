import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the unpairChannel logic by mocking external fetch calls
// and the credential store.

describe('unpairChannel', () => {
  const originalEnv = { ...process.env };
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', mockFetch);
    // Reset credential store singleton
    (globalThis as Record<string, unknown>).__credentialStore = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('unpairs telegram: calls deleteWebhook and clears credentials', async () => {
    const { CredentialStore } =
      await import('../../../src/server/channels/credentials/credentialStore');
    const store = new CredentialStore(':memory:');
    store.setCredential('telegram', 'bot_token', 'test-token');
    store.setCredential('telegram', 'webhook_secret', 'test-secret');
    (globalThis as Record<string, unknown>).__credentialStore = store;

    const { unpairChannel } = await import('../../../src/server/channels/pairing/unpair');
    await unpairChannel('telegram');

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
    const { CredentialStore } =
      await import('../../../src/server/channels/credentials/credentialStore');
    const store = new CredentialStore(':memory:');
    store.setCredential('discord', 'bot_token', 'dc-token');
    (globalThis as Record<string, unknown>).__credentialStore = store;

    const { unpairChannel } = await import('../../../src/server/channels/pairing/unpair');
    await unpairChannel('discord');

    expect(store.getCredential('discord', 'bot_token')).toBeNull();
    // No external API call expected for Discord
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws for unsupported channel', async () => {
    const { unpairChannel } = await import('../../../src/server/channels/pairing/unpair');
    await expect(unpairChannel('signal' as 'telegram')).rejects.toThrow('Unsupported channel');
  });
});
