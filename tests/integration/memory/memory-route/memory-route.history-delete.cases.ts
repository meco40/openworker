import { beforeEach, describe, expect, it } from 'vitest';
import {
  DELETE,
  GET,
  POST,
  PUT,
  makePostRequest,
  personaId,
  setupMemoryRouteTestEnv,
} from './memory-route.harness';

describe('/api/memory route', () => {
  beforeEach(setupMemoryRouteTestEnv);
  it('returns 409 on stale expectedVersion via PUT', async () => {
    const storeResponse = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'persist-me', importance: 4 },
      }),
    );
    const storeJson = await storeResponse.json();
    const nodeId = String(storeJson?.result?.data?.id || '');
    expect(nodeId.length).toBeGreaterThan(0);

    const firstUpdate = await PUT(
      makePostRequest({
        personaId,
        id: nodeId,
        content: 'persist-me-v2',
        expectedVersion: 1,
      }),
    );
    expect(firstUpdate.status).toBe(200);

    const staleUpdate = await PUT(
      makePostRequest({
        personaId,
        id: nodeId,
        content: 'persist-me-stale',
        expectedVersion: 1,
      }),
    );
    const staleJson = await staleUpdate.json();
    expect(staleUpdate.status).toBe(409);
    expect(staleJson.ok).toBe(false);
    expect(String(staleJson.error || '')).toMatch(/version|conflict/i);
  });

  it('returns memory history via GET with history flag', async () => {
    const storeResponse = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'persist-me', importance: 4 },
      }),
    );
    const storeJson = await storeResponse.json();
    const nodeId = String(storeJson?.result?.data?.id || '');
    expect(nodeId.length).toBeGreaterThan(0);

    await PUT(
      makePostRequest({
        personaId,
        id: nodeId,
        content: 'persist-me-updated',
        importance: 5,
      }),
    );

    const historyResponse = await GET(
      new Request(
        `http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}&id=${encodeURIComponent(nodeId)}&history=1`,
      ),
    );
    const historyJson = await historyResponse.json();
    expect(historyResponse.status).toBe(200);
    expect(historyJson.ok).toBe(true);
    expect(historyJson.node.id).toBe(nodeId);
    expect(Array.isArray(historyJson.history)).toBe(true);
    expect(historyJson.history.length).toBeGreaterThanOrEqual(2);
  });

  it('restores memory from history index via PUT', async () => {
    const storeResponse = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'persist-me', importance: 4 },
      }),
    );
    const storeJson = await storeResponse.json();
    const nodeId = String(storeJson?.result?.data?.id || '');
    expect(nodeId.length).toBeGreaterThan(0);

    await PUT(
      makePostRequest({
        personaId,
        id: nodeId,
        content: 'persist-me-updated',
        importance: 5,
        expectedVersion: 1,
      }),
    );

    const restoreResponse = await PUT(
      makePostRequest({
        personaId,
        id: nodeId,
        restoreIndex: 0,
        expectedVersion: 2,
      }),
    );
    const restoreJson = await restoreResponse.json();
    expect(restoreResponse.status).toBe(200);
    expect(restoreJson.ok).toBe(true);
    expect(restoreJson.node.id).toBe(nodeId);
    expect(restoreJson.node.content).toBe('persist-me');
  });

  it('deletes one memory node via DELETE', async () => {
    const storeResponse = await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'persist-me', importance: 4 },
      }),
    );
    const storeJson = await storeResponse.json();
    const nodeId = String(storeJson?.result?.data?.id || '');
    expect(nodeId.length).toBeGreaterThan(0);

    const deleteResponse = await DELETE(
      new Request(
        `http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}&id=${encodeURIComponent(nodeId)}`,
        { method: 'DELETE' },
      ),
    );
    const deleteJson = await deleteResponse.json();
    expect(deleteResponse.status).toBe(200);
    expect(deleteJson.ok).toBe(true);
    expect(deleteJson.deleted).toBe(1);

    const listResponse = await GET(
      new Request(`http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}`),
    );
    const listJson = await listResponse.json();
    expect(listResponse.status).toBe(200);
    expect(listJson.nodes).toHaveLength(0);
  });

  it('requires explicit confirm token before deleting all persona memory', async () => {
    await POST(
      makePostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'guarded-delete-all', importance: 4 },
      }),
    );

    const unconfirmedDelete = await DELETE(
      new Request(`http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}`, {
        method: 'DELETE',
      }),
    );
    const unconfirmedJson = await unconfirmedDelete.json();
    expect(unconfirmedDelete.status).toBe(400);
    expect(unconfirmedJson.ok).toBe(false);
    expect(String(unconfirmedJson.error || '')).toMatch(/confirm/i);

    const listBeforeConfirmedDelete = await GET(
      new Request(`http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}`),
    );
    const listBeforeConfirmedDeleteJson = await listBeforeConfirmedDelete.json();
    expect(listBeforeConfirmedDelete.status).toBe(200);
    expect(listBeforeConfirmedDeleteJson.ok).toBe(true);
    expect(listBeforeConfirmedDeleteJson.nodes).toHaveLength(1);

    const confirmedDelete = await DELETE(
      new Request(
        `http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}&confirm=delete-all-memory`,
        { method: 'DELETE' },
      ),
    );
    const confirmedDeleteJson = await confirmedDelete.json();
    expect(confirmedDelete.status).toBe(200);
    expect(confirmedDeleteJson.ok).toBe(true);
    expect(confirmedDeleteJson.deleted).toBe(1);
  });
});
