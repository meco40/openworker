import { describe, expect, it, vi } from 'vitest';
import {
  GET as listAccounts,
  POST as createAccount,
} from '../../../app/api/model-hub/accounts/route';
import { POST as testAccount } from '../../../app/api/model-hub/accounts/[accountId]/test/route';
import fs from 'node:fs';
import path from 'node:path';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function buildCreateRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/model-hub/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function buildTestRequest() {
  return new Request('http://localhost/api/model-hub/accounts/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

function buildCodexAccessToken(accountId = 'acct_test'): string {
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
      },
    }),
  ).toString('base64url');
  return `header.${payload}.signature`;
}

describe('model-hub account test route', () => {
  it('tests a created account and persists connectivity failure message', async () => {
    process.env.MODEL_HUB_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
    const dbPath = path.join(getTestArtifactsRoot(), 'model-hub.account-test-route.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    process.env.MODEL_HUB_DB_PATH = dbPath;
    (globalThis as { __modelHubRepository?: unknown }).__modelHubRepository = undefined;
    (globalThis as { __modelHubService?: unknown }).__modelHubService = undefined;

    const createResponse = await createAccount(
      buildCreateRequest({
        providerId: 'openai-codex',
        label: 'Probe Codex',
        authMethod: 'oauth',
        secret: buildCodexAccessToken('acct_integration'),
      }),
    );
    const created = await createResponse.json();
    expect(createResponse.status).toBe(200);
    expect(created.ok).toBe(true);
    const accountId = String(created.account.id);

    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: { message: 'token invalid for models scope' } }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as unknown as typeof fetch;

    const testResponse = await testAccount(buildTestRequest(), {
      params: Promise.resolve({ accountId }),
    });
    const json = await testResponse.json();
    expect(testResponse.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.connectivity.ok).toBe(false);
    expect(String(json.connectivity.message)).toContain('token invalid for models scope');

    const listResponse = await listAccounts();
    const listJson = await listResponse.json();
    expect(listResponse.status).toBe(200);
    expect(listJson.ok).toBe(true);
    const account = (
      listJson.accounts as Array<{ id: string; lastCheckMessage?: string | null }>
    ).find((entry) => entry.id === accountId);
    expect(account).toBeTruthy();
    expect(account?.lastCheckMessage).toContain('token invalid for models scope');

    global.fetch = originalFetch;
  });
});
