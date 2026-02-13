import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillRuntimeConfigStore } from '../../../src/server/skills/runtimeConfig';

type MockUserContext = { userId: string; authenticated: boolean } | null;

function mockUserContext(context: MockUserContext): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

describe('/api/skills/runtime-config', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).__skillRuntimeConfigStore;
  });

  it('returns 401 when user context is missing', async () => {
    mockUserContext(null);

    const route = await import('../../../app/api/skills/runtime-config/route');
    const response = await route.GET();

    expect(response.status).toBe(401);
  });

  it('stores and clears runtime config values', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    (globalThis as Record<string, unknown>).__skillRuntimeConfigStore =
      new SkillRuntimeConfigStore(':memory:');

    const route = await import('../../../app/api/skills/runtime-config/route');

    const putResponse = await route.PUT(
      new Request('http://localhost/api/skills/runtime-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'vision.gemini_api_key',
          value: 'stored-abc-1234',
        }),
      }),
    );
    expect(putResponse.status).toBe(200);

    const listResponse = await route.GET();
    const listJson = (await listResponse.json()) as {
      ok: boolean;
      configs: Array<{ id: string; configured: boolean; source: string | null }>;
    };
    expect(listResponse.status).toBe(200);
    expect(listJson.ok).toBe(true);
    const vision = listJson.configs.find((item) => item.id === 'vision.gemini_api_key');
    expect(vision?.configured).toBe(true);
    expect(vision?.source).toBe('store');

    const deleteResponse = await route.DELETE(
      new Request('http://localhost/api/skills/runtime-config?id=vision.gemini_api_key', {
        method: 'DELETE',
      }),
    );
    expect(deleteResponse.status).toBe(200);

    const listAfterDelete = await route.GET();
    const afterJson = (await listAfterDelete.json()) as {
      ok: boolean;
      configs: Array<{ id: string; configured: boolean }>;
    };
    const afterVision = afterJson.configs.find((item) => item.id === 'vision.gemini_api_key');
    expect(afterVision?.configured).toBe(false);
  });
});
