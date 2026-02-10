import { describe, expect, it } from 'vitest';
import { GET } from '../../../app/api/model-hub/oauth/start/route';

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
});

