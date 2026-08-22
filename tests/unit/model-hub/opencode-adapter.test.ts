import { afterEach, describe, expect, it, vi } from 'vitest';
import openCodeProviderAdapter from '@/server/model-hub/Models/opencode';
import type { ProviderCatalogEntry } from '@/server/model-hub/types';

const provider: ProviderCatalogEntry = {
  id: 'opencode',
  name: 'OpenCode',
  icon: 'OC',
  authMethods: ['api_key'],
  endpointType: 'openai-compatible',
  capabilities: ['chat', 'tools'],
  defaultModels: ['big-pickle'],
  apiBaseUrl: 'https://opencode.ai/zen/v1',
};

const context = {
  provider,
  account: {} as never,
  secret: 'oc-sk-test',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenCode provider adapter', () => {
  it('maps the OpenCode models response into Model Hub models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'big-pickle', owned_by: 'opencode', created: 1787365504 },
            { id: 'deepseek-v4-pro', owned_by: 'opencode' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(openCodeProviderAdapter.fetchModels?.(context)).resolves.toEqual([
      {
        id: 'big-pickle',
        name: 'big-pickle',
        provider: 'opencode',
        owned_by: 'opencode',
        created: 1787365504,
      },
      {
        id: 'deepseek-v4-pro',
        name: 'deepseek-v4-pro',
        provider: 'opencode',
        owned_by: 'opencode',
        created: undefined,
      },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.ai/zen/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer oc-sk-test' },
      }),
    );
  });

  it('dispatches chat completions through the OpenCode Zen base URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'pong' } }],
          model: 'big-pickle',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await openCodeProviderAdapter.dispatchGateway?.(context, {
      model: 'big-pickle',
      messages: [{ role: 'user', content: 'ping' }],
    });

    expect(result).toMatchObject({
      ok: true,
      text: 'pong',
      provider: 'opencode',
      model: 'big-pickle',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.ai/zen/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer oc-sk-test' }),
      }),
    );
  });
});
