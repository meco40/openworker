import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../../../app/api/memory/route';

interface EmbeddingPayload {
  content?: { parts?: Array<{ text?: string }> };
  requests?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

function makePostRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function resetMemorySingletons(): void {
  (globalThis as { __memoryRepository?: unknown }).__memoryRepository = undefined;
  (globalThis as { __memoryService?: unknown }).__memoryService = undefined;
}

describe('/api/memory route', () => {
  let dbPath = '';

  beforeEach(() => {
    dbPath = path.join(
      process.cwd(),
      '.local',
      `memory.route.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    process.env.MEMORY_DB_PATH = dbPath;
    resetMemorySingletons();

    (globalThis as { __modelHubService?: unknown }).__modelHubService = {
      dispatchEmbedding: vi.fn(
        async (_key: string, input: { operation: string; payload: EmbeddingPayload }) => {
          const text: string =
            input.payload?.content?.parts?.[0]?.text ||
            input.payload?.requests?.[0]?.content?.parts?.[0]?.text ||
            '';
          if (text === 'persist-me' || text === 'find-me') {
            return { embedding: { values: [1, 0] } };
          }
          return { embedding: { values: [0, 1] } };
        },
      ),
    };
  });

  it('stores memory via POST and returns persisted nodes via GET', async () => {
    const storeResponse = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { type: 'fact', content: 'persist-me', importance: 4 },
      }),
    );
    const storeJson = await storeResponse.json();

    expect(storeResponse.status).toBe(200);
    expect(storeJson.ok).toBe(true);
    expect(storeJson.result.action).toBe('store');

    const listResponse = await GET();
    const listJson = await listResponse.json();
    expect(listResponse.status).toBe(200);
    expect(listJson.ok).toBe(true);
    expect(listJson.nodes).toHaveLength(1);
    expect(listJson.nodes[0].content).toBe('persist-me');
  });

  it('recalls relevant memory context via POST', async () => {
    await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { type: 'preference', content: 'persist-me', importance: 3 },
      }),
    );

    const recallResponse = await POST(
      makePostRequest({
        fcName: 'core_memory_recall',
        args: { query: 'find-me', limit: 5 },
      }),
    );
    const recallJson = await recallResponse.json();

    expect(recallResponse.status).toBe(200);
    expect(recallJson.ok).toBe(true);
    expect(recallJson.result.action).toBe('recall');
    expect(recallJson.result.data).toContain('[Type: preference] persist-me');
  });

  it('returns 400 for invalid payload', async () => {
    const response = await POST(
      makePostRequest({
        fcName: 'unsupported_call',
        args: {},
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.ok).toBe(false);
  });
});
