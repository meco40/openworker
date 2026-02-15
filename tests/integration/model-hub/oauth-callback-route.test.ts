import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as startOAuth } from '../../../app/api/model-hub/oauth/start/route';
import { GET as callbackOAuth } from '../../../app/api/model-hub/oauth/callback/route';
import { GET as listAccounts } from '../../../app/api/model-hub/accounts/route';

const ORIGINAL_ENV = { ...process.env };

function resetSingletons() {
  (globalThis as { __modelHubRepository?: unknown }).__modelHubRepository = undefined;
  (globalThis as { __modelHubService?: unknown }).__modelHubService = undefined;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('model-hub oauth callback route', () => {
  it('exchanges OpenRouter code and creates an oauth account', async () => {
    process.env.MODEL_HUB_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
    const dbPath = path.join(process.cwd(), '.local', 'model-hub.oauth-callback-route.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    process.env.MODEL_HUB_DB_PATH = dbPath;
    resetSingletons();

    const startRequest = new Request(
      'http://localhost/api/model-hub/oauth/start?providerId=openrouter&label=OR%20OAuth',
      { method: 'GET' },
    );
    const startResponse = await startOAuth(startRequest);
    const location = startResponse.headers.get('location');
    expect(location).toBeTruthy();
    const state = new URL(String(location)).searchParams.get('state');
    expect(state).toBeTruthy();

    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ key: 'or-sk-test-0001' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const callbackRequest = new Request(
      `http://localhost/api/model-hub/oauth/callback?code=test-code&state=${encodeURIComponent(String(state))}`,
      { method: 'GET' },
    );

    const callbackResponse = await callbackOAuth(callbackRequest);
    const html = await callbackResponse.text();
    expect(callbackResponse.status).toBe(200);
    expect(html).toContain('MODEL_HUB_OAUTH_RESULT');

    const listResponse = await listAccounts();
    const listJson = await listResponse.json();
    expect(listJson.ok).toBe(true);
    expect(Array.isArray(listJson.accounts)).toBe(true);
    expect(listJson.accounts.length).toBeGreaterThan(0);
    expect(listJson.accounts[0].providerId).toBe('openrouter');
    expect(listJson.accounts[0].authMethod).toBe('oauth');

    global.fetch = originalFetch;
  });

  it('exchanges OpenAI code with optional client secret and stores oauth account', async () => {
    process.env.MODEL_HUB_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
    process.env.OPENAI_OAUTH_CLIENT_ID = 'openai-client-id';
    process.env.OPENAI_OAUTH_CLIENT_SECRET = 'openai-client-secret';
    process.env.OPENAI_OAUTH_AUDIENCE = 'https://api.openai.com/v1';

    const dbPath = path.join(process.cwd(), '.local', 'model-hub.oauth-callback-openai-route.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    process.env.MODEL_HUB_DB_PATH = dbPath;
    resetSingletons();

    const startRequest = new Request(
      'http://localhost/api/model-hub/oauth/start?providerId=openai&label=OpenAI%20OAuth',
      { method: 'GET' },
    );
    const startResponse = await startOAuth(startRequest);
    const location = startResponse.headers.get('location');
    expect(location).toBeTruthy();
    const state = new URL(String(location)).searchParams.get('state');
    expect(state).toBeTruthy();

    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body || '');
      expect(body).toContain('client_id=openai-client-id');
      expect(body).toContain('client_secret=openai-client-secret');
      expect(body).toContain('audience=https%3A%2F%2Fapi.openai.com%2Fv1');
      return new Response(
        JSON.stringify({ access_token: 'oa-access-token', refresh_token: 'oa-refresh-token' }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const callbackRequest = new Request(
      `http://localhost/api/model-hub/oauth/callback?code=test-code&state=${encodeURIComponent(String(state))}`,
      { method: 'GET' },
    );

    const callbackResponse = await callbackOAuth(callbackRequest);
    const html = await callbackResponse.text();
    expect(callbackResponse.status).toBe(200);
    expect(html).toContain('MODEL_HUB_OAUTH_RESULT');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const tokenUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(tokenUrl).toContain('/oauth/token');

    const listResponse = await listAccounts();
    const listJson = await listResponse.json();
    expect(listJson.ok).toBe(true);
    expect(Array.isArray(listJson.accounts)).toBe(true);
    expect(listJson.accounts.length).toBeGreaterThan(0);
    expect(listJson.accounts[0].providerId).toBe('openai');
    expect(listJson.accounts[0].authMethod).toBe('oauth');

    global.fetch = originalFetch;
  });
});
