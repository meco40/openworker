import { afterEach, describe, expect, it, vi } from 'vitest';
import adapter, { DEEPSEEK_MODEL } from '@/server/model-hub/Models/refuseless';
import { PROVIDER_CATALOG } from '@/server/model-hub/providerCatalog';
import { mapPipelineReasoningEffort } from '@/server/model-hub/service/utils';

const provider = PROVIDER_CATALOG.find((entry) => entry.id === 'refuseless')!;
const context = { provider, account: {} as never, secret: 'refuseless-test-key' };
afterEach(() => vi.restoreAllMocks());

describe('Refuseless adapter', () => {
  it('registers the correct endpoint and enriches the model without duplicates', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ id: DEEPSEEK_MODEL.id }] })));
    expect(provider.apiBaseUrl).toBe('https://api.refuseless.com/v1');
    expect(provider.authMethods).toEqual(['api_key']);
    const models = await adapter.fetchModels!(context);
    expect(models).toEqual([
      expect.objectContaining({
        id: DEEPSEEK_MODEL.id,
        name: DEEPSEEK_MODEL.name,
        provider: 'refuseless',
        context_window: 1048576,
      }),
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.refuseless.com/v1/models');
  });

  it('keeps the supplied model available when the live list is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"data":[]}'));
    expect(await adapter.fetchModels!(context)).toEqual([
      expect.objectContaining({ id: DEEPSEEK_MODEL.id, context_window: 1048576 }),
    ]);
  });

  it('uses bearer auth, tools and supported reasoning with the output cap', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })),
      );
    const result = await adapter.dispatchGateway!(context, {
      model: DEEPSEEK_MODEL.id,
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 200000,
      reasoning_effort: 'medium',
      tools: [{ type: 'function', function: { name: 'probe', parameters: { type: 'object' } } }],
    });
    expect(result).toMatchObject({ ok: true, text: 'OK', provider: 'refuseless' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.refuseless.com/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer refuseless-test-key');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      max_tokens: 131072,
      reasoning_effort: 'low',
      tools: [{ function: { name: 'probe' } }],
    });
    expect(mapPipelineReasoningEffort('off', 'refuseless')).toBe('none');
  });

  it('does not turn an invalid key into a successful connectivity test', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Invalid API key', { status: 401 }),
    );
    expect(await adapter.testConnectivity!(context)).toMatchObject({
      ok: false,
      message: expect.stringContaining('Invalid API key'),
    });
  });

  it('retains model metadata on a network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network unavailable'));
    expect(await adapter.fetchModels!(context)).toEqual([
      expect.objectContaining({
        id: DEEPSEEK_MODEL.id,
        name: DEEPSEEK_MODEL.name,
        context_window: 1048576,
      }),
    ]);
  });
});
