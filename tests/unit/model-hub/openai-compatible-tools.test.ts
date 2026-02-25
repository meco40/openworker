import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('dispatchOpenAICompatibleChat tool-calling support', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('forwards gateway tools to OpenAI-compatible request body', async () => {
    const fetchWithTimeout = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          model: 'gpt-4o-mini',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const resolveModelHubGatewayTimeoutMs = vi.fn(() => 180_000);
    vi.doMock('../../../src/server/model-hub/Models/shared/http', () => ({
      fetchWithTimeout,
      resolveModelHubGatewayTimeoutMs,
    }));

    const { dispatchOpenAICompatibleChat } =
      await import('@/server/model-hub/Models/shared/openaiCompatible');

    await dispatchOpenAICompatibleChat('https://api.example.com/v1', 'sk-test', 'openai', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'safe_files',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    });

    const body = JSON.parse(String(fetchWithTimeout.mock.calls[0]?.[1]?.body)) as {
      tools?: Array<{ function?: { name?: string } }>;
    };
    expect(body.tools).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({ name: 'safe_files' }),
      }),
    ]);
    expect(resolveModelHubGatewayTimeoutMs).toHaveBeenCalledWith({ hasTools: true });
    expect(fetchWithTimeout.mock.calls[0]?.[2]).toBe(180_000);
  });

  it('maps tool_calls from response into functionCalls', async () => {
    const fetchWithTimeout = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  {
                    type: 'function',
                    function: {
                      name: 'safe_files',
                      arguments: '{"operation":"read","path":"README.md"}',
                    },
                  },
                ],
              },
            },
          ],
          model: 'gpt-4o-mini',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const resolveModelHubGatewayTimeoutMs = vi.fn(() => 60_000);
    vi.doMock('../../../src/server/model-hub/Models/shared/http', () => ({
      fetchWithTimeout,
      resolveModelHubGatewayTimeoutMs,
    }));

    const { dispatchOpenAICompatibleChat } =
      await import('@/server/model-hub/Models/shared/openaiCompatible');

    const result = await dispatchOpenAICompatibleChat(
      'https://api.example.com/v1',
      'sk-test',
      'openai',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'read file' }],
      },
    );

    expect(result.ok).toBe(true);
    expect(result.functionCalls).toEqual([
      { name: 'safe_files', args: { operation: 'read', path: 'README.md' } },
    ]);
    expect(resolveModelHubGatewayTimeoutMs).toHaveBeenCalledWith({ hasTools: false });
    expect(fetchWithTimeout.mock.calls[0]?.[2]).toBe(60_000);
  });
});
