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

  it('redirects to OpenAI authorization and includes PKCE + audience', async () => {
    process.env.OPENAI_OAUTH_CLIENT_ID = 'openai-client-id';

    const request = new Request(
      'http://localhost/api/model-hub/oauth/start?providerId=openai&label=OpenAI%20OAuth',
      { method: 'GET' },
    );

    const response = await GET(request);
    expect(response.status).toBe(302);

    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    expect(location).toContain('auth0.openai.com/authorize');
    expect(location).toContain('code_challenge=');
    expect(location).toContain('code_challenge_method=S256');
    expect(location).toContain('state=');
    expect(location).toContain('audience=https%3A%2F%2Fapi.openai.com%2Fv1');
  });
});
