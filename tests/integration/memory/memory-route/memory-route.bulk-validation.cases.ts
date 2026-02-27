import { beforeEach, describe, expect, it } from 'vitest';
import {
  GET,
  PATCH,
  POST,
  makePostRequest,
  personaId,
  setupMemoryRouteTestEnv,
} from './memory-route.harness';

describe('/api/memory route', () => {
  beforeEach(setupMemoryRouteTestEnv);
  it('supports bulk update and bulk delete via PATCH', async () => {
    const first = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'bulk-a', importance: 2 },
      }),
    );
    const second = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'preference', content: 'bulk-b', importance: 3 },
      }),
    );
    const firstJson = await first.json();
    const secondJson = await second.json();
    const idA = String(firstJson?.result?.data?.id || '');
    const idB = String(secondJson?.result?.data?.id || '');

    const bulkUpdateResponse = await PATCH(
      makePostRequest({
        personaId,
        ids: [idA, idB],
        action: 'update',
        type: 'lesson',
        importance: 5,
      }),
    );
    const bulkUpdateJson = await bulkUpdateResponse.json();
    expect(bulkUpdateResponse.status).toBe(200);
    expect(bulkUpdateJson.ok).toBe(true);
    expect(bulkUpdateJson.affected).toBe(2);

    const listAfterUpdate = await GET(
      new Request(`http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}`),
    );
    const listAfterUpdateJson = await listAfterUpdate.json();
    expect(
      listAfterUpdateJson.nodes.every((node: { type: string }) => node.type === 'lesson'),
    ).toBe(true);
    expect(
      listAfterUpdateJson.nodes.every((node: { importance: number }) => node.importance === 5),
    ).toBe(true);

    const bulkDeleteResponse = await PATCH(
      makePostRequest({
        personaId,
        ids: [idA, idB],
        action: 'delete',
      }),
    );
    const bulkDeleteJson = await bulkDeleteResponse.json();
    expect(bulkDeleteResponse.status).toBe(200);
    expect(bulkDeleteJson.ok).toBe(true);
    expect(bulkDeleteJson.affected).toBe(2);
  });

  it('returns 400 when personaId is missing', async () => {
    const response = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { type: 'fact', content: 'persist-me', importance: 4 },
      }),
    );
    const json = await response.json();
    expect(response.status).toBe(400);
    expect(json.ok).toBe(false);

    const listResponse = await GET(new Request('http://localhost/api/memory'));
    const listJson = await listResponse.json();
    expect(listResponse.status).toBe(400);
    expect(listJson.ok).toBe(false);
  });

  it('returns 400 for unsupported bulk action values', async () => {
    const first = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'bulk-invalid-action', importance: 2 },
      }),
    );
    const firstJson = await first.json();
    const id = String(firstJson?.result?.data?.id || '');
    expect(id.length).toBeGreaterThan(0);

    const response = await PATCH(
      makePostRequest({
        personaId,
        ids: [id],
        action: 'noop',
        type: 'lesson',
      }),
    );
    const json = await response.json();
    expect(response.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(String(json.error || '')).toMatch(/action/i);
  });

  it('returns 401 when auth is required and request user context is unavailable', async () => {
    const previousRequireAuth = process.env.REQUIRE_AUTH;
    process.env.REQUIRE_AUTH = 'true';
    try {
      const response = await GET(
        new Request(`http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}`),
      );
      const json = await response.json();
      expect(response.status).toBe(401);
      expect(json.ok).toBe(false);
    } finally {
      if (previousRequireAuth === undefined) {
        delete process.env.REQUIRE_AUTH;
      } else {
        process.env.REQUIRE_AUTH = previousRequireAuth;
      }
    }
  });
});
