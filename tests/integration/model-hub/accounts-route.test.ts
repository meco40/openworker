import { describe, expect, it } from 'vitest';
import { GET, POST } from '../../../app/api/model-hub/accounts/route';
import fs from 'node:fs';
import path from 'node:path';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function buildRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/model-hub/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('model-hub accounts route', () => {
  it('creates and lists provider accounts', async () => {
    process.env.MODEL_HUB_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
    const dbPath = path.join(getTestArtifactsRoot(), 'model-hub.accounts-route.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    process.env.MODEL_HUB_DB_PATH = dbPath;

    const createResponse = await POST(
      buildRequest({
        providerId: 'openai',
        label: 'Primary OpenAI',
        authMethod: 'api_key',
        secret: 'sk-test-123456',
      }),
    );
    const createJson = await createResponse.json();
    expect(createResponse.status).toBe(200);
    expect(createJson.ok).toBe(true);
    expect(createJson.account.providerId).toBe('openai');

    const listResponse = await GET();
    const listJson = await listResponse.json();
    expect(listResponse.status).toBe(200);
    expect(Array.isArray(listJson.accounts)).toBe(true);
    expect(listJson.accounts.length).toBeGreaterThan(0);
  });

  it('creates local provider account without secret when authMethod is none', async () => {
    process.env.MODEL_HUB_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
    const dbPath = path.join(getTestArtifactsRoot(), 'model-hub.accounts-route.local.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    process.env.MODEL_HUB_DB_PATH = dbPath;

    const createResponse = await POST(
      buildRequest({
        providerId: 'ollama',
        label: 'Local Ollama',
        authMethod: 'none',
      }),
    );
    const createJson = await createResponse.json();
    expect(createResponse.status).toBe(200);
    expect(createJson.ok).toBe(true);
    expect(createJson.account.providerId).toBe('ollama');
    expect(createJson.account.authMethod).toBe('none');
  });
});
