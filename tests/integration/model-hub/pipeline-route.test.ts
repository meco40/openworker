import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { POST as createAccount } from '../../../app/api/model-hub/accounts/route';
import {
  GET as getPipeline,
  POST as mutatePipeline,
} from '../../../app/api/model-hub/pipeline/route';

function buildJsonRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/model-hub/pipeline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('model-hub pipeline route reorder', () => {
  it('reorders models while preserving status', async () => {
    process.env.MODEL_HUB_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
    const dbPath = path.join(process.cwd(), '.local', 'model-hub.pipeline-route.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    process.env.MODEL_HUB_DB_PATH = dbPath;
    (globalThis as { __modelHubRepository?: unknown }).__modelHubRepository = undefined;
    (globalThis as { __modelHubService?: unknown }).__modelHubService = undefined;

    const accountResponse = await createAccount(
      new Request('http://localhost/api/model-hub/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'openai',
          label: 'Primary OpenAI',
          authMethod: 'api_key',
          secret: 'sk-test-123456',
        }),
      }),
    );
    const accountJson = (await accountResponse.json()) as { account?: { id?: string } };
    const accountId = accountJson.account?.id;
    expect(accountId).toBeTruthy();

    await mutatePipeline(
      buildJsonRequest({
        action: 'add',
        profileId: 'p1',
        accountId,
        providerId: 'openai',
        modelName: 'alpha',
        priority: 1,
      }),
    );
    await mutatePipeline(
      buildJsonRequest({
        action: 'add',
        profileId: 'p1',
        accountId,
        providerId: 'openai',
        modelName: 'beta',
        priority: 2,
      }),
    );

    const beforeResponse = await getPipeline(
      new Request('http://localhost/api/model-hub/pipeline?profileId=p1'),
    );
    const beforeJson = (await beforeResponse.json()) as {
      models?: Array<{ id: string; modelName: string; status: string }>;
    };
    const beta = beforeJson.models?.find((model) => model.modelName === 'beta');
    expect(beta).toBeTruthy();

    await mutatePipeline(
      buildJsonRequest({
        action: 'status',
        modelId: beta?.id,
        status: 'offline',
      }),
    );

    const reorderResponse = await mutatePipeline(
      buildJsonRequest({
        action: 'reorder',
        profileId: 'p1',
        modelId: beta?.id,
        direction: 'up',
      }),
    );
    const reorderJson = (await reorderResponse.json()) as { ok?: boolean; moved?: boolean };
    expect(reorderResponse.status).toBe(200);
    expect(reorderJson.ok).toBe(true);
    expect(reorderJson.moved).toBe(true);

    const afterResponse = await getPipeline(
      new Request('http://localhost/api/model-hub/pipeline?profileId=p1'),
    );
    const afterJson = (await afterResponse.json()) as {
      models?: Array<{ modelName: string; status: string }>;
    };
    expect(afterJson.models?.map((model) => model.modelName)).toEqual(['beta', 'alpha']);
    expect(afterJson.models?.[0]?.status).toBe('offline');
  });

  it('stores reasoningEffort for codex pipeline entries', async () => {
    process.env.MODEL_HUB_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
    const dbPath = path.join(process.cwd(), '.local', 'model-hub.pipeline-route.reasoning.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    process.env.MODEL_HUB_DB_PATH = dbPath;
    (globalThis as { __modelHubRepository?: unknown }).__modelHubRepository = undefined;
    (globalThis as { __modelHubService?: unknown }).__modelHubService = undefined;

    const accountResponse = await createAccount(
      new Request('http://localhost/api/model-hub/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'openai-codex',
          label: 'Codex OAuth',
          authMethod: 'oauth',
          secret: 'codex-access-token',
        }),
      }),
    );
    const accountJson = (await accountResponse.json()) as { account?: { id?: string } };
    const accountId = accountJson.account?.id;
    expect(accountId).toBeTruthy();

    const addResponse = await mutatePipeline(
      buildJsonRequest({
        action: 'add',
        profileId: 'p1',
        accountId,
        providerId: 'openai-codex',
        modelName: 'gpt-5.3-codex',
        priority: 1,
        reasoningEffort: 'xhigh',
      }),
    );
    const addJson = (await addResponse.json()) as {
      model?: { reasoningEffort?: string };
    };
    expect(addResponse.status).toBe(200);
    expect(addJson.model?.reasoningEffort).toBe('xhigh');

    const getResponse = await getPipeline(
      new Request('http://localhost/api/model-hub/pipeline?profileId=p1'),
    );
    const getJson = (await getResponse.json()) as {
      models?: Array<{ modelName: string; reasoningEffort?: string }>;
    };
    expect(getResponse.status).toBe(200);
    expect(getJson.models?.[0]?.modelName).toBe('gpt-5.3-codex');
    expect(getJson.models?.[0]?.reasoningEffort).toBe('xhigh');
  });
});
