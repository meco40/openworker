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
    const resolveModelHubGatewayTimeoutMs = vi.fn(() => 180_000);

    vi.doMock('../../../src/server/model-hub/Models/shared/http', () => ({
      fetchWithTimeout,
      fetchJsonOk: vi.fn(),
      resolveModelHubGatewayTimeoutMs,
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
      max_output_tokens?: number;
      max_tokens?: number;
      tools?: Array<Record<string, unknown>>;
    };

    expect(body.max_output_tokens).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        name: 'safe_files',
      }),
    ]);
    expect(body.tools?.[0]?.function).toBeUndefined();
    expect(resolveModelHubGatewayTimeoutMs).toHaveBeenCalledWith({ hasTools: true });
    expect(fetchWithTimeout.mock.calls[0]?.[2]).toBe(180_000);
  });

  it('maps Graphiti max_tokens to xAI Responses max_output_tokens', async () => {
    const fetchWithTimeout = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ output: [], model: 'grok-4', usage: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    vi.doMock('../../../src/server/model-hub/Models/shared/http', () => ({
      fetchWithTimeout,
      fetchJsonOk: vi.fn(),
      resolveModelHubGatewayTimeoutMs: vi.fn(() => 180_000),
    }));

    const { default: adapter } = await import('@/server/model-hub/Models/xai');
    await adapter.dispatchGateway?.(
      {
        secret: 'xai-test-key',
        provider: {
          id: 'xai',
          name: 'xAI',
          icon: 'x',
          authMethods: ['api_key'],
          endpointType: 'xai-native',
          capabilities: ['chat'],
          defaultModels: ['grok-4'],
        },
        account: {} as never,
      },
      {
        model: 'grok-4',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 16384,
      },
    );

    const body = JSON.parse(String(fetchWithTimeout.mock.calls[0]?.[1]?.body)) as {
      max_output_tokens?: number;
      max_tokens?: number;
    };
    expect(body.max_output_tokens).toBe(16384);
    expect(body.max_tokens).toBeUndefined();
  });

  it('maps Graphiti JSON response formats to xAI Responses text.format', async () => {
    const fetchWithTimeout = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ output: [], model: 'grok-4', usage: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    vi.doMock('../../../src/server/model-hub/Models/shared/http', () => ({
      fetchWithTimeout,
      fetchJsonOk: vi.fn(),
      resolveModelHubGatewayTimeoutMs: vi.fn(() => 180_000),
    }));

    const { default: adapter } = await import('@/server/model-hub/Models/xai');
    await adapter.dispatchGateway?.(
      {
        secret: 'xai-test-key',
        provider: {
          id: 'xai',
          name: 'xAI',
          icon: 'x',
          authMethods: ['api_key'],
          endpointType: 'xai-native',
          capabilities: ['chat'],
          defaultModels: ['grok-4'],
        },
        account: {} as never,
      },
      {
        model: 'grok-4',
        messages: [{ role: 'user', content: 'hello' }],
        responseFormat: {
          type: 'json_schema',
          json_schema: { name: 'entities', schema: { type: 'object' }, strict: true },
        },
      },
    );

    const body = JSON.parse(String(fetchWithTimeout.mock.calls[0]?.[1]?.body)) as {
      text?: { format?: Record<string, unknown> };
    };
    expect(body.text?.format).toEqual({
      type: 'json_schema',
      name: 'entities',
      schema: { type: 'object' },
      strict: true,
    });
  });
});
