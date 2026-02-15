import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '../../../app/api/model-hub/oauth/start/route';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('model-hub oauth start route', () => {
  it('redirects to OpenRouter authorization with PKCE', async () => {
    const request = new Request(
      'http://localhost/api/model-hub/oauth/start?providerId=openrouter&label=OpenRouter%20Main',
      { method: 'GET' },
    );

    const response = await GET(request);
    expect(response.status).toBe(302);

    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    expect(location).toContain('https://openrouter.ai/auth');
    expect(location).toContain('code_challenge=');
    expect(location).toContain('state=');
  });

  it('redirects to OpenAI Codex authorization and includes PKCE params without env client id', async () => {
    delete process.env.OPENAI_OAUTH_CLIENT_ID;
    process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-empty-'));

    const request = new Request(
      'http://localhost/api/model-hub/oauth/start?providerId=openai-codex&label=OpenAI%20Codex',
      { method: 'GET' },
    );

    const response = await GET(request);
    expect(response.status).toBe(302);

    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    expect(location).toContain('auth.openai.com/oauth/authorize');
    expect(location).toContain('client_id=app_EMoamEEZ73f0CkXaXp7hrann');
    expect(location).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback');
    expect(location).toContain('code_challenge=');
    expect(location).toContain('code_challenge_method=S256');
    expect(location).toContain('state=');
    expect(location).toContain('codex_cli_simplified_flow=true');
    expect(location).toContain('originator=pi');
  });

  it('does not auto-connect from local codex auth file and still redirects to oauth', async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-with-auth-'));
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'token-from-local-file',
          refresh_token: 'refresh-from-local-file',
          account_id: 'acc_local',
        },
      }),
      'utf8',
    );
    process.env.CODEX_HOME = codexHome;
    delete process.env.OPENAI_OAUTH_CLIENT_ID;

    const request = new Request(
      'http://localhost/api/model-hub/oauth/start?providerId=openai-codex&label=Codex%20OAuth',
      { method: 'GET' },
    );

    const response = await GET(request);
    expect(response.status).toBe(302);
    const location = response.headers.get('location');
    expect(location).toContain('auth.openai.com/oauth/authorize');
  });

  it('normalizes callback origin when request host is 0.0.0.0 and custom client id is used', async () => {
    process.env.OPENAI_OAUTH_CLIENT_ID = 'custom-client-id';
    delete process.env.OPENAI_OAUTH_REDIRECT_URI;

    const request = new Request(
      'http://0.0.0.0:3000/api/model-hub/oauth/start?providerId=openai-codex&label=Codex%20OAuth',
      { method: 'GET' },
    );

    const response = await GET(request);
    expect(response.status).toBe(302);
    const location = String(response.headers.get('location') || '');
    expect(location).toContain('client_id=custom-client-id');
    expect(location).toContain(
      'redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Fmodel-hub%2Foauth%2Fcallback',
    );
  });
});
