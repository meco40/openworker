import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('xAI adapter tool mapping', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('maps OpenAI tools to xAI Responses API function tools with top-level name', async () => {
    const fetchWithTimeout = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'ok' }],
            },
          ],
          model: 'grok-4',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    vi.doMock('../../../src/server/model-hub/Models/shared/http', () => ({
      fetchWithTimeout,
      fetchJsonOk: vi.fn(),
    }));

    const { default: adapter } = await import('@/server/model-hub/Models/xai');

    const result = await adapter.dispatchGateway?.(
      {
        secret: 'xai-test-key',
        provider: {
          id: 'xai',
          name: 'xAI',
          icon: 'x',
          authMethods: ['api_key'],
          endpointType: 'xai-native',
          capabilities: ['chat', 'tools'],
          defaultModels: ['grok-4'],
        },
        account: {} as never,
      },
      {
        model: 'grok-4',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'safe_files',
              description: 'Read files',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      },
    );

    expect(result?.ok).toBe(true);
    const body = JSON.parse(String(fetchWithTimeout.mock.calls[0]?.[1]?.body)) as {
      tools?: Array<Record<string, unknown>>;
    };

    expect(body.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        name: 'safe_files',
      }),
    ]);
    expect(body.tools?.[0]?.function).toBeUndefined();
  });
});
