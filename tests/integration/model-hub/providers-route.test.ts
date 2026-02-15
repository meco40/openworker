import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '../../../app/api/model-hub/providers/route';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('model-hub providers route', () => {
  it('keeps OpenAI as api-key provider and exposes OpenAI Codex oauth separately', async () => {
    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);

    const providers = json.providers as Array<{
      id: string;
      authMethods: string[];
      oauthConfigured?: boolean;
    }>;
    const openai = providers.find((provider) => provider.id === 'openai');
    const codex = providers.find((provider) => provider.id === 'openai-codex');

    expect(openai).toBeTruthy();
    expect(openai?.authMethods).toContain('api_key');
    expect(openai?.authMethods).not.toContain('oauth');

    expect(codex).toBeTruthy();
    expect(codex?.authMethods).toContain('oauth');
    expect(codex?.authMethods).not.toContain('api_key');
    expect(codex?.oauthConfigured).toBe(true);
  });

  it('keeps openai-codex oauth configured when openai oauth client id is present', async () => {
    process.env.OPENAI_OAUTH_CLIENT_ID = 'openai-client-id';

    const response = await GET();
    const json = await response.json();
    expect(response.status).toBe(200);

    const codex = (json.providers as Array<{ id: string; oauthConfigured?: boolean }>).find(
      (provider) => provider.id === 'openai-codex',
    );
    expect(codex).toBeTruthy();
    expect(codex?.oauthConfigured).toBe(true);
  });

  it('hides github oauth when oauth app is not configured', async () => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);

    const github = (json.providers as Array<{ id: string; authMethods: string[] }>).find(
      (provider) => provider.id === 'github-copilot',
    );
    expect(github).toBeTruthy();
    expect(github?.authMethods).toContain('api_key');
    expect(github?.authMethods).not.toContain('oauth');
  });

  it('exposes local providers with no-auth option first', async () => {
    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);

    const ollama = (json.providers as Array<{ id: string; authMethods: string[] }>).find(
      (provider) => provider.id === 'ollama',
    );
    const lmstudio = (json.providers as Array<{ id: string; authMethods: string[] }>).find(
      (provider) => provider.id === 'lmstudio',
    );

    expect(ollama).toBeTruthy();
    expect(ollama?.authMethods[0]).toBe('none');

    expect(lmstudio).toBeTruthy();
    expect(lmstudio?.authMethods[0]).toBe('none');
  });
});
