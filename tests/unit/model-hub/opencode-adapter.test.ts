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
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'big-pickle', owned_by: 'opencode', created: 1787365504 },
              { id: 'x-preview-f-free', owned_by: 'opencode' },
              { id: 'deepseek-v4-pro', owned_by: 'opencode' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            opencode: {
              models: {
                'big-pickle': {
                  name: 'Big Pickle',
                  limit: { context: 200000 },
                  cost: { input: 0, output: 0 },
                },
                'x-preview-f-free': {
                  name: 'Ox Alpha Free (Unlimited)',
                  cost: { input: 0, output: 0, cache_read: 0 },
                },
                'deepseek-v4-pro': {
                  name: 'DeepSeek V4 Pro',
                  cost: { input: 0.5, output: 2 },
                },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    await expect(openCodeProviderAdapter.fetchModels?.(context)).resolves.toEqual([
      {
        id: 'big-pickle',
        name: 'Big Pickle',
        provider: 'opencode',
        owned_by: 'opencode',
        created: 1787365504,
        context_window: 200000,
        billing: 'free',
      },
      {
        id: 'x-preview-f-free',
        name: 'Ox Alpha Free',
        provider: 'opencode',
        owned_by: 'opencode',
        created: undefined,
        billing: 'free',
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        provider: 'opencode',
        owned_by: 'opencode',
        created: undefined,
        billing: 'paid',
      },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.ai/zen/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer oc-sk-test' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://models.dev/api.json',
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' },
      }),
    );
  });

  it('keeps the live models when metadata is unavailable without guessing paid status', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { id: 'x-preview-f-free', owned_by: 'opencode' },
              { id: 'future-model', owned_by: 'opencode' },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockRejectedValueOnce(new Error('metadata unavailable'));

    await expect(openCodeProviderAdapter.fetchModels?.(context)).resolves.toEqual([
      {
        id: 'x-preview-f-free',
        name: 'Ox Alpha Free',
        provider: 'opencode',
        owned_by: 'opencode',
        created: undefined,
        billing: 'free',
      },
      {
        id: 'future-model',
        name: 'future-model',
        provider: 'opencode',
        owned_by: 'opencode',
        created: undefined,
        billing: undefined,
      },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://models.dev/api.json',
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' },
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
