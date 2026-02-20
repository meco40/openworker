import { describe, it, expect, beforeEach } from 'vitest';
import { CredentialStore } from '@/server/channels/credentials/credentialStore';

describe('CredentialStore', () => {
  let store: CredentialStore;

  beforeEach(() => {
    // Use in-memory SQLite for tests
    store = new CredentialStore(':memory:');
  });

  it('sets and gets a credential', () => {
    store.setCredential('telegram', 'bot_token', 'abc123');
    expect(store.getCredential('telegram', 'bot_token')).toBe('abc123');
  });

  it('returns null for non-existent credential', () => {
    expect(store.getCredential('telegram', 'bot_token')).toBeNull();
  });

  it('upserts existing credential', () => {
    store.setCredential('telegram', 'bot_token', 'old');
    store.setCredential('telegram', 'bot_token', 'new');
    expect(store.getCredential('telegram', 'bot_token')).toBe('new');
  });

  it('isolates credentials per channel', () => {
    store.setCredential('telegram', 'bot_token', 'tg-token');
    store.setCredential('discord', 'bot_token', 'dc-token');
    expect(store.getCredential('telegram', 'bot_token')).toBe('tg-token');
    expect(store.getCredential('discord', 'bot_token')).toBe('dc-token');
  });

  it('isolates credentials per key', () => {
    store.setCredential('telegram', 'bot_token', 'token');
    store.setCredential('telegram', 'webhook_secret', 'secret');
    expect(store.getCredential('telegram', 'bot_token')).toBe('token');
    expect(store.getCredential('telegram', 'webhook_secret')).toBe('secret');
  });

  it('deletes all credentials for a channel', () => {
    store.setCredential('telegram', 'bot_token', 'token');
    store.setCredential('telegram', 'webhook_secret', 'secret');
    store.setCredential('discord', 'bot_token', 'dc-token');

    store.deleteCredentials('telegram');

    expect(store.getCredential('telegram', 'bot_token')).toBeNull();
    expect(store.getCredential('telegram', 'webhook_secret')).toBeNull();
    // Discord credentials should be unaffected
    expect(store.getCredential('discord', 'bot_token')).toBe('dc-token');
  });

  it('lists credentials for a channel', () => {
    store.setCredential('telegram', 'bot_token', 'token');
    store.setCredential('telegram', 'webhook_secret', 'secret');
    store.setCredential('discord', 'bot_token', 'dc-token');

    const creds = store.listCredentials('telegram');
    expect(creds.length).toBe(2);
    expect(creds.map((c) => c.key).sort()).toEqual(['bot_token', 'webhook_secret']);
    expect(creds[0].channel).toBe('telegram');
  });

  it('returns empty list for channel with no credentials', () => {
    expect(store.listCredentials('nonexistent')).toEqual([]);
  });
});
