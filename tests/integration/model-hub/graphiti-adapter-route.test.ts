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

function buildRequest(token = 'graphiti-test-token'): Request {
  return new Request('http://localhost/api/internal/model-hub/graphiti/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'graphiti-json',
      messages: [{ role: 'user', content: 'Extract this as JSON.' }],
      response_format: { type: 'json_object' },
    }),
  });
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

  it('dispatches through the active p1-graphiti profile and its primary model', async () => {
    graphitiService.listPipeline.mockReturnValue([
      {
        id: 'graphiti-primary',
        profileId: 'p1-graphiti',
        accountId: 'account-openrouter',
        providerId: 'openrouter',
        modelName: 'provider/json-model',
        priority: 1,
        status: 'active',
      },
      {
        id: 'graphiti-secondary',
        profileId: 'p1-graphiti',
        accountId: 'account-openai',
        providerId: 'openai',
        modelName: 'fallback/json-model',
        priority: 2,
        status: 'active',
      },
    ]);
    graphitiService.dispatchWithFallback.mockResolvedValue({
      ok: true,
      text: '{"entities":[]}',
      model: 'provider/json-model',
      provider: 'openrouter',
    });

    const response = await POST(buildRequest(), {
      params: Promise.resolve({ path: ['v1', 'chat', 'completions'] }),
    });

    expect(response.status).toBe(200);
    expect(graphitiService.listPipeline).toHaveBeenCalledWith('p1-graphiti');
    expect(graphitiService.dispatchWithFallback).toHaveBeenCalledWith(
      'p1-graphiti',
      'model-hub-test-key',
      expect.objectContaining({ messages: expect.any(Array) }),
      { modelOverride: 'provider/json-model' },
    );
  });

  it('fails clearly when p1-graphiti has no active model', async () => {
    graphitiService.listPipeline.mockReturnValue([
      {
        id: 'graphiti-offline',
        profileId: 'p1-graphiti',
        accountId: 'account-openrouter',
        providerId: 'openrouter',
        modelName: 'provider/json-model',
        priority: 1,
        status: 'offline',
      },
    ]);

    const response = await POST(buildRequest(), {
      params: Promise.resolve({ path: ['v1', 'chat', 'completions'] }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('p1-graphiti') },
    });
    expect(graphitiService.dispatchWithFallback).not.toHaveBeenCalled();
  });

  it('rejects requests without the internal Graphiti bearer token', async () => {
    const response = await POST(buildRequest('wrong-token'), {
      params: Promise.resolve({ path: ['v1', 'chat', 'completions'] }),
    });

    expect(response.status).toBe(401);
    expect(graphitiService.listPipeline).not.toHaveBeenCalled();
  });
});
