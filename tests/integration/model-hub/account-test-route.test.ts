import { describe, expect, it } from 'vitest';
import { POST as createAccount } from '../../../app/api/model-hub/accounts/route';
import { POST as testAccount } from '../../../app/api/model-hub/accounts/[accountId]/test/route';
import fs from 'node:fs';
import path from 'node:path';

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

describe('model-hub account test route', () => {
  it('tests a created account and returns connectivity shape', async () => {
    process.env.MODEL_HUB_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
    const dbPath = path.join(process.cwd(), '.local', 'model-hub.account-test-route.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    process.env.MODEL_HUB_DB_PATH = dbPath;

    const createResponse = await createAccount(
      buildCreateRequest({
        providerId: 'openai',
        label: 'Probe OpenAI',
        authMethod: 'api_key',
        secret: 'sk-test-654321',
      }),
    );
    const created = await createResponse.json();
    expect(createResponse.status).toBe(200);
    expect(created.ok).toBe(true);
    const accountId = String(created.account.id);

    const testResponse = await testAccount(buildTestRequest(), { params: { accountId } });
    const json = await testResponse.json();
    expect(testResponse.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(typeof json.connectivity.ok).toBe('boolean');
  });
});
