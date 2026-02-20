import { describe, expect, it } from 'vitest';
import { CredentialStore } from '../../../src/server/channels/credentials/credentialStore';
import {
  listBridgeAccountIds,
  normalizeBridgeAccountId,
  parseScopedBridgeExternalChatId,
  removeBridgeAccount,
  resolveBridgeAccountIdFromRequest,
  resolveBridgeAccountSecret,
  scopeBridgeExternalChatId,
  upsertBridgeAccount,
} from '../../../src/server/channels/pairing/bridgeAccounts';

describe('bridge account helpers', () => {
  it('normalizes account ids and falls back to default', () => {
    expect(normalizeBridgeAccountId()).toBe('default');
    expect(normalizeBridgeAccountId(' Team_A ')).toBe('team_a');
    expect(() => normalizeBridgeAccountId('INVALID*ID')).toThrow('Invalid accountId');
  });

  it('stores, lists and removes account-scoped bridge credentials', () => {
    const store = new CredentialStore(':memory:');
    upsertBridgeAccount(
      'whatsapp',
      {
        accountId: 'sales',
        pairingStatus: 'connected',
        webhookSecret: 'secret-sales',
      },
      store,
    );

    expect(listBridgeAccountIds('whatsapp', store)).toEqual(['sales']);
    expect(resolveBridgeAccountSecret('whatsapp', 'sales', store)).toBe('secret-sales');

    removeBridgeAccount('whatsapp', 'sales', store);
    expect(listBridgeAccountIds('whatsapp', store)).toEqual([]);
    expect(resolveBridgeAccountSecret('whatsapp', 'sales', store)).toBe('');
  });

  it('scopes external chat IDs for non-default accounts and can parse them back', () => {
    const scoped = scopeBridgeExternalChatId('sales', '491234@s.whatsapp.net');
    const parsed = parseScopedBridgeExternalChatId(scoped);
    expect(parsed).toEqual({
      accountId: 'sales',
      externalChatId: '491234@s.whatsapp.net',
    });

    const plain = parseScopedBridgeExternalChatId('plain-chat-id');
    expect(plain).toEqual({
      accountId: 'default',
      externalChatId: 'plain-chat-id',
    });
  });

  it('resolves account id from request body/header/query (body has precedence)', () => {
    const req = new Request('https://example.local/webhook?accountId=query', {
      method: 'POST',
      headers: {
        'x-openclaw-account-id': 'header',
      },
      body: '{}',
    });

    const resolved = resolveBridgeAccountIdFromRequest({
      request: req,
      bodyAccountId: 'body',
    });
    expect(resolved).toBe('body');
  });
});
