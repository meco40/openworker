import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as createAccount } from '../../../app/api/model-hub/accounts/route';
import { GET as listModels } from '../../../app/api/model-hub/accounts/[accountId]/models/route';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

const ORIGINAL_ENV = { ...process.env };

function resetSingletons() {
  (globalThis as { __modelHubRepository?: unknown }).__modelHubRepository = undefined;
  (globalThis as { __modelHubService?: unknown }).__modelHubService = undefined;
}

function buildCreateRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/model-hub/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('model-hub account models route', () => {
  it('returns codex default models when provider model lookup is empty', async () => {
    process.env.MODEL_HUB_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
    const dbPath = path.join(getTestArtifactsRoot(), 'model-hub.account-models-route.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    process.env.MODEL_HUB_DB_PATH = dbPath;
    resetSingletons();

    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => {
      return new Response('unauthorized', { status: 401 });
    }) as unknown as typeof fetch;

    const createResponse = await createAccount(
      buildCreateRequest({
        providerId: 'openai-codex',
        label: 'Codex Account',
        authMethod: 'oauth',
        secret: 'codex-access-token',
      }),
    );
    const createJson = await createResponse.json();
    expect(createResponse.status).toBe(200);
    expect(createJson.ok).toBe(true);

    const accountId = String(createJson.account.id);
    const response = await listModels(
      new Request('http://localhost/api/model-hub/accounts/a/models'),
      {
        params: Promise.resolve({ accountId }),
      },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.models)).toBe(true);
    expect(json.models.length).toBeGreaterThan(0);
    const ids = (json.models as Array<{ id: string }>).map((model) => model.id);
    expect(ids).toContain('gpt-5.3-codex');
    expect(ids).toContain('gpt-5.1-codex');

    global.fetch = originalFetch;
  });
});
