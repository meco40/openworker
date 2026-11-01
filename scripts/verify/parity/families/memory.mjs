/**
 * `/api/memory` parity (S5): store, page, update/history, bulk update and delete.
 * Both implementations use isolated SQLite files; provider-specific PostgreSQL
 * behavior remains covered by the S6 integration lane.
 */
import { check, goldenReference, rustRequest } from '../harness.mjs';

export const name = 'memory';

const PERSONA_ID = 'parity-memory-persona';
const WORKSPACE_ID = 'parity-memory-workspace';

function normNode(node) {
  const metadata = node?.metadata ?? {};
  return {
    type: node?.type ?? null,
    content: node?.content ?? null,
    importance: node?.importance ?? null,
    version: metadata.version ?? null,
    workspaceId: metadata.workspaceId ?? null,
    hasId: typeof node?.id === 'string' && node.id.length > 0,
    hasTimestamp: typeof node?.timestamp === 'string' && node.timestamp.length > 0,
  };
}

function normHistory(entries) {
  return entries.map((entry) => ({
    index: entry.index,
    action: entry.action,
    content: entry.content ?? null,
    type: entry.type ?? null,
    importance: entry.importance ?? null,
    version: entry.version ?? null,
  }));
}

async function rustSide() {
  const stored = await rustRequest('POST', '/api/memory', {
    body: {
      fcName: 'core_memory_store',
      args: {
        personaId: PERSONA_ID,
        workspaceId: WORKSPACE_ID,
        type: 'fact',
        content: 'Rust migration parity fact',
        importance: 3,
      },
    },
  });
  const id = stored.json?.result?.data?.id;
  const page = await rustRequest(
    'GET',
    `/api/memory?personaId=${PERSONA_ID}&workspaceId=${WORKSPACE_ID}&page=1&pageSize=25`,
  );
  const updated = await rustRequest('PUT', '/api/memory', {
    body: {
      personaId: PERSONA_ID,
      workspaceId: WORKSPACE_ID,
      id,
      content: 'Updated Rust migration parity fact',
      importance: 4,
      expectedVersion: 1,
    },
  });
  const history = await rustRequest(
    'GET',
    `/api/memory?personaId=${PERSONA_ID}&workspaceId=${WORKSPACE_ID}&id=${id}&history=true`,
  );
  const second = await rustRequest('POST', '/api/memory', {
    body: {
      fcName: 'core_memory_store',
      args: {
        personaId: PERSONA_ID,
        workspaceId: WORKSPACE_ID,
        type: 'preference',
        content: 'Second parity memory',
      },
    },
  });
  const secondId = second.json?.result?.data?.id;
  const bulk = await rustRequest('PATCH', '/api/memory', {
    body: {
      personaId: PERSONA_ID,
      workspaceId: WORKSPACE_ID,
      ids: [id, secondId, id],
      action: 'update',
      importance: 5,
    },
  });
  const deletedOne = await rustRequest(
    'DELETE',
    `/api/memory?personaId=${PERSONA_ID}&workspaceId=${WORKSPACE_ID}&id=${secondId}`,
  );
  const deletedAll = await rustRequest(
    'DELETE',
    `/api/memory?personaId=${PERSONA_ID}&workspaceId=${WORKSPACE_ID}&confirm=delete-all-memory`,
  );
  const empty = await rustRequest(
    'GET',
    `/api/memory?personaId=${PERSONA_ID}&workspaceId=${WORKSPACE_ID}&page=1&pageSize=25`,
  );

  return {
    store: { status: stored.status, node: normNode(stored.json?.result?.data) },
    page: {
      status: page.status,
      nodes: (page.json?.nodes ?? []).map(normNode),
      pagination: page.json?.pagination,
    },
    update: { status: updated.status, node: normNode(updated.json?.node) },
    history: {
      status: history.status,
      node: normNode(history.json?.node),
      entries: normHistory(history.json?.history ?? []),
    },
    bulk: { status: bulk.status, body: bulk.json },
    deleteOne: { status: deletedOne.status, body: deletedOne.json },
    deleteAll: { status: deletedAll.status, body: deletedAll.json },
    empty: {
      status: empty.status,
      nodes: (empty.json?.nodes ?? []).map(normNode),
      pagination: empty.json?.pagination,
    },
  };
}

export async function run() {
  const ts = await goldenReference(name, 'typescript');
  const rust = await rustSide();

  for (const key of [
    'store',
    'page',
    'update',
    'history',
    'bulk',
    'deleteOne',
    'deleteAll',
    'empty',
  ]) {
    check(`${key} CRUD-Vertrag`, rust[key], ts[key]);
  }
}
