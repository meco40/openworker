import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getOpenAICodexClientId,
  OPENAI_CODEX_PUBLIC_CLIENT_ID,
  readCodexCliCredentials,
  refreshOpenAICodexToken,
} from '@/server/model-hub/codexAuth';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('codexAuth', () => {
  it('uses public codex client id by default', () => {
    delete process.env.OPENAI_OAUTH_CLIENT_ID;
    expect(getOpenAICodexClientId()).toBe(OPENAI_CODEX_PUBLIC_CLIENT_ID);
  });

  it('reads codex credentials from CODEX_HOME auth.json', () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-test-'));
    fs.writeFileSync(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token:
            'eyJhbGciOiJIUzI1NiJ9.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjXzEyMyJ9fQ.signature',
          refresh_token: 'refresh-token',
        },
      }),
      'utf8',
    );
    process.env.CODEX_HOME = codexHome;

    const credentials = readCodexCliCredentials();
    expect(credentials).toBeTruthy();
    expect(credentials?.source).toBe('auth_file');
    expect(credentials?.refreshToken).toBe('refresh-token');
    expect(credentials?.accountId).toBe('acc_123');
  });

  it('refreshes openai codex token using fallback public client id', async () => {
    delete process.env.OPENAI_OAUTH_CLIENT_ID;

    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body || '');
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain(`client_id=${OPENAI_CODEX_PUBLIC_CLIENT_ID}`);
      return new Response(
        JSON.stringify({
          access_token:
            'eyJhbGciOiJIUzI1NiJ9.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjXzQ1NiJ9fQ.signature',
          refresh_token: 'refresh-2',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const refreshed = await refreshOpenAICodexToken('refresh-1');
    expect(refreshed.refreshToken).toBe('refresh-2');
    expect(refreshed.accountId).toBe('acc_456');
    expect(typeof refreshed.expiresAt).toBe('number');
  });
});
