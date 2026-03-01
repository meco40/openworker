import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { POST as createAccount } from '../../../app/api/model-hub/accounts/route';
import { POST as testAll } from '../../../app/api/model-hub/accounts/test-all/route';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function buildCreateRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/model-hub/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function buildTestAllRequest(body: Record<string, unknown> = {}) {
  return new Request('http://localhost/api/model-hub/accounts/test-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('model-hub accounts test-all route', () => {
  it('runs connectivity checks for all stored accounts', async () => {
    process.env.MODEL_HUB_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
    const dbPath = path.join(getTestArtifactsRoot(), 'model-hub.accounts-test-all-route.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    process.env.MODEL_HUB_DB_PATH = dbPath;
    (globalThis as { __modelHubRepository?: unknown }).__modelHubRepository = undefined;
    (globalThis as { __modelHubService?: unknown }).__modelHubService = undefined;

    const createResponse = await createAccount(
      buildCreateRequest({
        providerId: 'openai',
        label: 'OpenAI bulk test',
        authMethod: 'api_key',
        secret: 'sk-test-bulk-123',
      }),
    );
    const createJson = await createResponse.json();
    expect(createJson.ok).toBe(true);

    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const testResponse = await testAll(buildTestAllRequest());
    const testJson = await testResponse.json();
    expect(testResponse.status).toBe(200);
    expect(testJson.ok).toBe(true);
    expect(testJson.total).toBe(1);
    expect(testJson.successCount).toBe(1);
    expect(Array.isArray(testJson.results)).toBe(true);

    global.fetch = originalFetch;
  });
});
