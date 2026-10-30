/**
 * `/api/memory` parity (S5): store, page, update/history, bulk update and delete.
 * Both implementations use isolated SQLite files; provider-specific PostgreSQL
 * behavior remains covered by the S6 integration lane.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, rustRequest, bestEffortRemoveDir } from '../harness.mjs';

export const name = 'memory';

const PERSONA_ID = 'parity-memory-persona';
const WORKSPACE_ID = 'parity-memory-workspace';
const USER_ID = 'parity-memory-user';

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

async function typescriptSide() {
  const dir = mkdtempSync(join(tmpdir(), 'betaclaw-parity-memory-'));
  const names = ['MEMORY_PROVIDER', 'MEMORY_DB_PATH', 'WORLD_MODEL_ENABLED', 'NODE_ENV'];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env.MEMORY_PROVIDER = 'sqlite';
  process.env.MEMORY_DB_PATH = join(dir, 'memory.db');
  process.env.WORLD_MODEL_ENABLED = 'false';
  process.env.NODE_ENV = 'test';

  try {
    const {
      handleMemoryDelete,
      handleMemoryGet,
      handleMemoryPatch,
      handleMemoryPost,
      handleMemoryPut,
    } = await import('../../../../src/server/memory/api/index.ts');
    const handlers = {
      DELETE: handleMemoryDelete,
      GET: handleMemoryGet,
      PATCH: handleMemoryPatch,
      POST: handleMemoryPost,
      PUT: handleMemoryPut,
    };
    const context = { userId: USER_ID };
    const request = async (method, path, body) => {
      const init = { method };
      if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      const response = await handlers[method](
        new Request(`http://localhost/api/memory${path}`, init),
        context,
      );
      return { status: response.status, body: await response.json() };
    };

    const stored = await request('POST', '', {
      fcName: 'core_memory_store',
      args: {
        personaId: PERSONA_ID,
        workspaceId: WORKSPACE_ID,
        type: 'fact',
        content: 'Rust migration parity fact',
        importance: 3,
      },
    });
    const id = stored.body?.result?.data?.id;
    const page = await request(
      'GET',
      `?personaId=${PERSONA_ID}&workspaceId=${WORKSPACE_ID}&page=1&pageSize=25`,
    );
    const updated = await request('PUT', '', {
      personaId: PERSONA_ID,
      workspaceId: WORKSPACE_ID,
      id,
      content: 'Updated Rust migration parity fact',
      importance: 4,
      expectedVersion: 1,
    });
    const history = await request(
      'GET',
      `?personaId=${PERSONA_ID}&workspaceId=${WORKSPACE_ID}&id=${id}&history=true`,
    );
    const second = await request('POST', '', {
      fcName: 'core_memory_store',
      args: {
        personaId: PERSONA_ID,
        workspaceId: WORKSPACE_ID,
        type: 'preference',
        content: 'Second parity memory',
      },
    });
    const secondId = second.body?.result?.data?.id;
    const bulk = await request('PATCH', '', {
      personaId: PERSONA_ID,
      workspaceId: WORKSPACE_ID,
      ids: [id, secondId, id],
      action: 'update',
      importance: 5,
    });
    const deletedOne = await request(
      'DELETE',
      `?personaId=${PERSONA_ID}&workspaceId=${WORKSPACE_ID}&id=${secondId}`,
    );
    const deletedAll = await request(
      'DELETE',
      `?personaId=${PERSONA_ID}&workspaceId=${WORKSPACE_ID}&confirm=delete-all-memory`,
    );
    const empty = await request(
      'GET',
      `?personaId=${PERSONA_ID}&workspaceId=${WORKSPACE_ID}&page=1&pageSize=25`,
    );

    return {
      store: { status: stored.status, node: normNode(stored.body?.result?.data) },
      page: {
        status: page.status,
        nodes: (page.body?.nodes ?? []).map(normNode),
        pagination: page.body?.pagination,
      },
      update: { status: updated.status, node: normNode(updated.body?.node) },
      history: {
        status: history.status,
        node: normNode(history.body?.node),
        entries: normHistory(history.body?.history ?? []),
      },
      bulk: { status: bulk.status, body: bulk.body },
      deleteOne: { status: deletedOne.status, body: deletedOne.body },
      deleteAll: { status: deletedAll.status, body: deletedAll.body },
      empty: {
        status: empty.status,
        nodes: (empty.body?.nodes ?? []).map(normNode),
        pagination: empty.body?.pagination,
      },
    };
  } finally {
    globalThis.__memoryService = undefined;
    globalThis.__mem0Client = undefined;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    bestEffortRemoveDir(dir);
  }
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
  const ts = await typescriptSide();
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
