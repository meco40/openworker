import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialStore } from '../../../src/server/channels/credentials/credentialStore';
import {
  listBridgeAccounts,
  upsertBridgeAccount,
} from '../../../src/server/channels/pairing/bridgeAccounts';

type TestGlobals = typeof globalThis & {
  __credentialStore?: CredentialStore;
};

describe('whatsapp accounts route', () => {
  const previousMessagesDbPath = process.env.MESSAGES_DB_PATH;
  const previousRequireAuth = process.env.REQUIRE_AUTH;
  let store: CredentialStore;

  beforeEach(() => {
    process.env.MESSAGES_DB_PATH = ':memory:';
    delete process.env.REQUIRE_AUTH;
    store = new CredentialStore(':memory:');
    (globalThis as TestGlobals).__credentialStore = store;
  });

  afterEach(() => {
    if (previousMessagesDbPath === undefined) delete process.env.MESSAGES_DB_PATH;
    else process.env.MESSAGES_DB_PATH = previousMessagesDbPath;
    if (previousRequireAuth === undefined) delete process.env.REQUIRE_AUTH;
    else process.env.REQUIRE_AUTH = previousRequireAuth;
    (globalThis as TestGlobals).__credentialStore = undefined;
  });

  it('lists configured whatsapp accounts', async () => {
    upsertBridgeAccount(
      'whatsapp',
      {
        accountId: 'sales',
        pairingStatus: 'connected',
        peerName: 'wa-sales',
      },
      store,
    );

    const { GET } = await import('../../../app/api/channels/whatsapp/accounts/route');
    const response = await GET();
    const payload = (await response.json()) as {
      ok: boolean;
      accounts: Array<{ accountId: string; pairingStatus: string | null; allowFrom: string[] }>;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.accounts.some((entry) => entry.accountId === 'sales')).toBe(true);
  });

  it('updates allow_from entries for an account', async () => {
    const { PUT } = await import('../../../app/api/channels/whatsapp/accounts/route');
    const request = new Request('http://localhost/api/channels/whatsapp/accounts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'support',
        allowFrom: '+49123, +49123, Team-A',
      }),
    });

    const response = await PUT(request);
    const payload = (await response.json()) as {
      ok: boolean;
      accountId: string;
      allowFrom: string[];
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.accountId).toBe('support');
    expect(payload.allowFrom).toEqual(['+49123', 'team-a']);

    const support = listBridgeAccounts('whatsapp', store).find(
      (entry) => entry.accountId === 'support',
    );
    expect(support?.allowFrom).toEqual(['+49123', 'team-a']);
  });

  it('returns 401 when auth is required and no session exists', async () => {
    process.env.REQUIRE_AUTH = 'true';
    const { GET } = await import('../../../app/api/channels/whatsapp/accounts/route');
    const response = await GET();
    expect(response.status).toBe(401);
  });
});
