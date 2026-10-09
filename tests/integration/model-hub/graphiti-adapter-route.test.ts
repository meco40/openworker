import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const graphitiService = vi.hoisted(() => ({
  listPipeline: vi.fn(),
  dispatchWithFallback: vi.fn(),
}));

vi.mock('@/server/model-hub/runtime', () => ({
  getModelHubEncryptionKey: () => 'model-hub-test-key',
  getModelHubService: () => graphitiService,
}));

import { POST } from '../../../app/api/internal/model-hub/graphiti/[...path]/route';

const defaultBody = {
  model: 'graphiti-json',
  messages: [{ role: 'user', content: 'Extract this as JSON.' }],
  response_format: { type: 'json_object' },
};

function buildRequest(
  options: {
    authorization?: string | null;
    body?: unknown;
    rawBody?: string;
  } = {},
): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  const authorization =
    options.authorization === undefined ? 'Bearer graphiti-test-token' : options.authorization;
  if (authorization !== null) headers.set('authorization', authorization);
  const body = options.rawBody ?? JSON.stringify('body' in options ? options.body : defaultBody);
  return new Request('http://localhost/api/internal/model-hub/graphiti/v1/chat/completions', {
    method: 'POST',
    headers,
    body,
  });
}

function routeContext(path = ['v1', 'chat', 'completions']) {
  return { params: Promise.resolve({ path }) };
}

describe('Graphiti Model-Hub adapter route', () => {
  const originalToken = process.env.GRAPHITI_MODEL_HUB_TOKEN;
  const originalProfile = process.env.GRAPHITI_MODEL_HUB_PROFILE_ID;

  beforeEach(() => {
    process.env.GRAPHITI_MODEL_HUB_TOKEN = 'graphiti-test-token';
    delete process.env.GRAPHITI_MODEL_HUB_PROFILE_ID;
    graphitiService.listPipeline.mockReset();
    graphitiService.dispatchWithFallback.mockReset();
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.GRAPHITI_MODEL_HUB_TOKEN;
    else process.env.GRAPHITI_MODEL_HUB_TOKEN = originalToken;
    if (originalProfile === undefined) delete process.env.GRAPHITI_MODEL_HUB_PROFILE_ID;
    else process.env.GRAPHITI_MODEL_HUB_PROFILE_ID = originalProfile;
  });

  it('dispatches through the active p1-graphiti model and returns tool calls in OpenAI shape', async () => {
    graphitiService.listPipeline.mockReturnValue([
      {
        id: 'graphiti-offline',
        profileId: 'p1-graphiti',
        modelName: 'offline/json-model',
        priority: 1,
        status: 'offline',
      },
      {
        id: 'graphiti-primary',
        profileId: 'p1-graphiti',
        accountId: 'account-openrouter',
        providerId: 'openrouter',
        modelName: 'provider/json-model',
        priority: 2,
        status: 'active',
      },
      {
        id: 'graphiti-secondary',
        profileId: 'p1-graphiti',
        accountId: 'account-openai',
        providerId: 'openai',
        modelName: 'fallback/json-model',
        priority: 3,
        status: 'active',
      },
    ]);
    graphitiService.dispatchWithFallback.mockResolvedValue({
      ok: true,
      text: '{"entities":[]}',
      model: 'provider/json-model',
      provider: 'openrouter',
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      functionCalls: [
        { name: 'persist', args: '{"ok":true}' },
        { name: 'count', args: { value: 1 } },
        { name: 'finish' },
      ],
    });

    const response = await POST(
      buildRequest({
        body: {
          messages: [
            null,
            'ignored',
            { role: 'tool', content: 'ignored' },
            {
              role: 'system',
              content: [null, 1, {}, { text: 'System ' }, { content: 'content' }, { text: 2 }],
            },
            { role: 'user', content: { unsupported: true } },
            { role: 'assistant', content: 'Continue.' },
          ],
          max_tokens: 42,
          temperature: 0,
          tools: [{ type: 'function', function: { name: 'persist' } }],
          response_format: { type: 'json_schema', json_schema: { name: 'entities' } },
        },
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(graphitiService.listPipeline).toHaveBeenCalledWith('p1-graphiti');
    expect(graphitiService.dispatchWithFallback).toHaveBeenCalledWith(
      'p1-graphiti',
      'model-hub-test-key',
      expect.objectContaining({
        messages: [
          { role: 'system', content: 'System content' },
          { role: 'user', content: '' },
          { role: 'assistant', content: 'Continue.' },
        ],
        max_tokens: 42,
        temperature: 0,
        tools: [{ type: 'function', function: { name: 'persist' } }],
        responseMimeType: 'application/json',
        responseFormat: { type: 'json_schema', json_schema: { name: 'entities' } },
        auditContext: { kind: 'knowledge-extraction' },
      }),
      { modelOverride: 'provider/json-model' },
    );
    const payload = await response.json();
    expect(payload).toMatchObject({
      object: 'chat.completion',
      model: 'provider/json-model',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '{"entities":[]}',
            tool_calls: [
              {
                id: 'call_graphiti_1',
                type: 'function',
                function: { name: 'persist', arguments: '{"ok":true}' },
              },
              {
                id: 'call_graphiti_2',
                type: 'function',
                function: { name: 'count', arguments: '{"value":1}' },
              },
              {
                id: 'call_graphiti_3',
                type: 'function',
                function: { name: 'finish', arguments: '{}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      system_fingerprint: 'model-hub:openrouter',
    });
  });

  it('returns a normal completion without optional usage or tool-call fields', async () => {
    graphitiService.listPipeline.mockReturnValue([{ modelName: 'json-model', status: 'active' }]);
    graphitiService.dispatchWithFallback.mockResolvedValue({
      ok: true,
      text: '{"ok":true}',
      model: 'json-model',
      provider: 'openai',
    });

    const response = await POST(buildRequest(), routeContext(['chat', 'completions']));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
    });
    expect(payload).not.toHaveProperty('usage');
    expect(payload.choices[0].message).not.toHaveProperty('tool_calls');
  });

  it.each([
    ['provider error', 'upstream unavailable', 'upstream unavailable'],
    ['missing provider error', undefined, 'Model Hub dispatch failed.'],
  ])('maps %s to a gateway error', async (_label, error, message) => {
    graphitiService.listPipeline.mockReturnValue([{ modelName: 'json-model', status: 'active' }]);
    graphitiService.dispatchWithFallback.mockResolvedValue({
      ok: false,
      error,
      text: '',
      model: 'json-model',
      provider: 'openai',
    });

    const response = await POST(buildRequest(), routeContext());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { message, type: 'model_hub_gateway_error' },
    });
  });

  it('fails clearly when p1-graphiti has no active model', async () => {
    graphitiService.listPipeline.mockReturnValue([
      {
        id: 'graphiti-offline',
        profileId: 'p1-graphiti',
        modelName: 'provider/json-model',
        priority: 1,
        status: 'offline',
      },
    ]);

    const response = await POST(buildRequest(), routeContext());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('p1-graphiti') },
    });
    expect(graphitiService.dispatchWithFallback).not.toHaveBeenCalled();
  });

  it('rejects a missing internal token before contacting Model Hub', async () => {
    process.env.GRAPHITI_MODEL_HUB_TOKEN = '   ';

    const response = await POST(buildRequest(), routeContext());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { message: 'Graphiti Model-Hub adapter token is not configured.' },
    });
    expect(graphitiService.listPipeline).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['wrong scheme', 'Basic graphiti-test-token'],
    ['empty bearer value', 'Bearer    '],
    ['wrong token length', 'Bearer x'],
    ['wrong token with matching length', 'Bearer xxxxxxxxxxxxxxxxxx'],
  ])('rejects an unauthorized request with %s authorization', async (_label, authorization) => {
    const response = await POST(buildRequest({ authorization }), routeContext());

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { message: 'Unauthorized.' } });
    expect(graphitiService.listPipeline).not.toHaveBeenCalled();
  });

  it('accepts a case-insensitive bearer scheme and trims the configured secret', async () => {
    process.env.GRAPHITI_MODEL_HUB_TOKEN = ' graphiti-test-token ';
    graphitiService.listPipeline.mockReturnValue([{ modelName: 'json-model', status: 'active' }]);
    graphitiService.dispatchWithFallback.mockResolvedValue({
      ok: true,
      text: '{}',
      model: 'json-model',
      provider: 'openai',
    });

    const response = await POST(
      buildRequest({ authorization: 'bEaReR graphiti-test-token' }),
      routeContext(),
    );

    expect(response.status).toBe(200);
  });

  it('rejects unsupported endpoints before reading the request body', async () => {
    const response = await POST(
      buildRequest({ rawBody: 'not-json' }),
      routeContext(['v1', 'embeddings']),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { message: 'Only the chat completions endpoint is available.' },
    });
    expect(graphitiService.listPipeline).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and valid JSON without usable messages', async () => {
    const malformed = await POST(buildRequest({ rawBody: '{' }), routeContext());
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: { message: 'Request body must be valid JSON.' },
    });

    for (const body of [null, [], {}, { messages: [] }, { messages: 'not-an-array' }]) {
      const response = await POST(buildRequest({ body }), routeContext());
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { message: 'messages must not be empty.' },
      });
    }
    expect(graphitiService.listPipeline).not.toHaveBeenCalled();
  });

  it('omits invalid optional generation parameters and unsupported formats', async () => {
    graphitiService.listPipeline.mockReturnValue([{ modelName: 'json-model', status: 'active' }]);
    graphitiService.dispatchWithFallback.mockResolvedValue({
      ok: true,
      text: '{}',
      model: 'json-model',
      provider: 'openai',
    });

    await POST(
      buildRequest({
        body: {
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: '12',
          temperature: -1,
          tools: { type: 'function' },
          response_format: { type: 'text' },
        },
      }),
      routeContext(),
    );
    expect(graphitiService.dispatchWithFallback).toHaveBeenCalledWith(
      'p1-graphiti',
      'model-hub-test-key',
      expect.objectContaining({
        max_tokens: undefined,
        temperature: undefined,
        tools: undefined,
        responseMimeType: undefined,
        responseFormat: { type: 'text' },
      }),
      { modelOverride: 'json-model' },
    );

    await POST(
      buildRequest({
        rawBody:
          '{"messages":[{"role":"user","content":"hello"}],"max_tokens":1e999,"temperature":1e999}',
      }),
      routeContext(),
    );
    expect(graphitiService.dispatchWithFallback).toHaveBeenLastCalledWith(
      'p1-graphiti',
      'model-hub-test-key',
      expect.objectContaining({ max_tokens: undefined, temperature: undefined }),
      { modelOverride: 'json-model' },
    );
  });
});
