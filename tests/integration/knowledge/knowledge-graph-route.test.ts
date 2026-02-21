import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityAlias, EntityRelation, KnowledgeEntity } from '@/server/knowledge/entityGraph';

type RepoMock = {
  listEntities: ReturnType<typeof vi.fn>;
  getEntityWithRelations: ReturnType<typeof vi.fn>;
  getAliasCountsByEntityIds?: ReturnType<typeof vi.fn>;
  listRelationsByEntityIds?: ReturnType<typeof vi.fn>;
};

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

function buildRelation(
  sourceEntityId: string,
  targetEntityId: string,
  relationType: string,
): EntityRelation {
  return {
    id: `rel-${sourceEntityId}-${targetEntityId}`,
    sourceEntityId,
    targetEntityId,
    relationType,
    properties: {},
    confidence: 0.85,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createRepositoryMock(): RepoMock {
  const entities: KnowledgeEntity[] = [
    {
      id: 'ent-1',
      userId: 'user-a',
      personaId: 'persona-a',
      canonicalName: 'Alpha',
      category: 'project',
      owner: 'persona',
      properties: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'ent-2',
      userId: 'user-a',
      personaId: 'persona-a',
      canonicalName: 'Beta',
      category: 'person',
      owner: 'shared',
      properties: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'ent-3',
      userId: 'user-a',
      personaId: 'persona-a',
      canonicalName: 'Gamma',
      category: 'concept',
      owner: 'user',
      properties: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'ent-4',
      userId: 'user-a',
      personaId: 'persona-a',
      canonicalName: 'Delta',
      category: 'organization',
      owner: 'persona',
      properties: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const aliasesById = new Map<string, EntityAlias[]>([
    [
      'ent-1',
      [
        {
          id: 'alias-1',
          entityId: 'ent-1',
          alias: 'A',
          aliasType: 'abbreviation',
          owner: 'shared',
          confidence: 0.9,
          createdAt: new Date().toISOString(),
        },
      ],
    ],
    ['ent-2', []],
    ['ent-3', []],
    ['ent-4', []],
  ]);

  const relationsById = new Map<string, EntityRelation[]>([
    ['ent-1', [buildRelation('ent-1', 'ent-2', 'works_with')]],
    ['ent-2', [buildRelation('ent-2', 'ent-3', 'depends_on')]],
    ['ent-3', [buildRelation('ent-3', 'ent-4', 'part_of')]],
    ['ent-4', []],
  ]);

  const listEntities = vi.fn((filter: { userId: string; personaId: string }, limit = 100) => {
    if (filter.userId !== 'user-a') return [];
    const scoped = entities.filter(
      (entity) => entity.userId === filter.userId && entity.personaId === filter.personaId,
    );
    return scoped.slice(0, Math.max(0, limit));
  });

  const getEntityWithRelations = vi.fn((entityId: string) => {
    const entity = entities.find((entry) => entry.id === entityId);
    if (!entity) {
      throw new Error(`Entity ${entityId} not found`);
    }
    return {
      entity,
      aliases: aliasesById.get(entityId) || [],
      relations: relationsById.get(entityId) || [],
    };
  });

  return { listEntities, getEntityWithRelations };
}

function createBatchRepositoryMock(): RepoMock {
  const base = createRepositoryMock();
  const getAliasCountsByEntityIds = vi.fn((entityIds: string[]) => {
    const counts: Record<string, number> = {};
    for (const entityId of entityIds) {
      counts[entityId] = entityId === 'ent-1' ? 1 : 0;
    }
    return counts;
  });

  const listRelationsByEntityIds = vi.fn((entityIds: string[]) => {
    const set = new Set(entityIds);
    const allRelations: EntityRelation[] = [
      {
        id: 'rel-ent-1-ent-2',
        sourceEntityId: 'ent-1',
        targetEntityId: 'ent-2',
        relationType: 'works_with',
        properties: {},
        confidence: 0.85,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'rel-ent-2-ent-3',
        sourceEntityId: 'ent-2',
        targetEntityId: 'ent-3',
        relationType: 'depends_on',
        properties: {},
        confidence: 0.85,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'rel-ent-3-ent-4',
        sourceEntityId: 'ent-3',
        targetEntityId: 'ent-4',
        relationType: 'part_of',
        properties: {},
        confidence: 0.85,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    return allRelations.filter(
      (relation) => set.has(relation.sourceEntityId) && set.has(relation.targetEntityId),
    );
  });

  return {
    ...base,
    getAliasCountsByEntityIds,
    listRelationsByEntityIds,
  };
}

function mockKnowledgeRepository(repoMock: RepoMock): void {
  vi.doMock('../../../src/server/knowledge/runtime', () => ({
    getKnowledgeRepository: vi.fn(() => repoMock),
  }));
}

async function loadRoute() {
  return import('../../../app/api/knowledge/graph/route');
}

describe('/api/knowledge/graph route', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns 401 when user context is missing', async () => {
    mockUserContext(null);
    mockKnowledgeRepository(createRepositoryMock());
    const route = await loadRoute();

    const response = await route.GET(
      new Request('http://localhost/api/knowledge/graph?personaId=persona-a'),
    );
    const json = (await response.json()) as { ok: boolean; error?: string };

    expect(response.status).toBe(401);
    expect(json.ok).toBe(false);
    expect(String(json.error || '')).toMatch(/unauthorized/i);
  });

  it('returns 400 when personaId is missing', async () => {
    mockUserContext({ userId: 'user-a', authenticated: true });
    mockKnowledgeRepository(createRepositoryMock());
    const route = await loadRoute();

    const response = await route.GET(new Request('http://localhost/api/knowledge/graph'));
    const json = (await response.json()) as { ok: boolean; error?: string };

    expect(response.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(String(json.error || '')).toMatch(/personaId/i);
  });

  it('returns graph payload for authorized user scope', async () => {
    mockUserContext({ userId: 'user-a', authenticated: true });
    const repoMock = createRepositoryMock();
    mockKnowledgeRepository(repoMock);
    const route = await loadRoute();

    const response = await route.GET(
      new Request('http://localhost/api/knowledge/graph?personaId=persona-a'),
    );
    const json = (await response.json()) as {
      ok: boolean;
      graph: {
        nodes: Array<{
          id: string;
          label: string;
          category: string;
          owner: string;
          aliasCount: number;
        }>;
        edges: Array<{
          id: string;
          source: string;
          target: string;
          relationType: string;
          confidence: number;
        }>;
      };
      stats: {
        nodes: number;
        edges: number;
        categories: Record<string, number>;
        truncated: boolean;
      };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.graph.nodes.length).toBe(4);
    expect(json.graph.edges.length).toBe(3);
    expect(json.graph.nodes[0]).toHaveProperty('aliasCount');
    expect(json.stats.nodes).toBe(4);
    expect(json.stats.edges).toBe(3);
    expect(json.stats.categories.project).toBe(1);
    expect(json.stats.truncated).toBe(false);

    expect(repoMock.listEntities).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-a', personaId: 'persona-a' }),
      expect.any(Number),
    );
  });

  it('enforces maximum node limit and returns truncated stats', async () => {
    mockUserContext({ userId: 'user-a', authenticated: true });
    mockKnowledgeRepository(createRepositoryMock());
    const route = await loadRoute();

    const response = await route.GET(
      new Request('http://localhost/api/knowledge/graph?personaId=persona-a&limit=2'),
    );
    const json = (await response.json()) as {
      ok: boolean;
      graph: { nodes: Array<{ id: string }>; edges: Array<{ source: string; target: string }> };
      stats: { nodes: number; edges: number; truncated: boolean };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.graph.nodes.length).toBe(2);
    expect(json.stats.nodes).toBe(2);
    expect(json.stats.truncated).toBe(true);
    expect(
      json.graph.edges.every((edge) =>
        json.graph.nodes.some((node) => node.id === edge.source || node.id === edge.target),
      ),
    ).toBe(true);
  });

  it('isolates data by authenticated user scope', async () => {
    mockUserContext({ userId: 'user-b', authenticated: true });
    mockKnowledgeRepository(createRepositoryMock());
    const route = await loadRoute();

    const response = await route.GET(
      new Request('http://localhost/api/knowledge/graph?personaId=persona-a'),
    );
    const json = (await response.json()) as {
      ok: boolean;
      graph: { nodes: unknown[]; edges: unknown[] };
      stats: { nodes: number; edges: number };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.graph.nodes).toHaveLength(0);
    expect(json.graph.edges).toHaveLength(0);
    expect(json.stats.nodes).toBe(0);
    expect(json.stats.edges).toBe(0);
  });

  it('uses batch graph access methods when repository provides them', async () => {
    mockUserContext({ userId: 'user-a', authenticated: true });
    const repoMock = createBatchRepositoryMock();
    mockKnowledgeRepository(repoMock);
    const route = await loadRoute();

    const response = await route.GET(
      new Request('http://localhost/api/knowledge/graph?personaId=persona-a'),
    );
    const json = (await response.json()) as {
      ok: boolean;
      graph: { nodes: unknown[]; edges: unknown[] };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(repoMock.getAliasCountsByEntityIds).toHaveBeenCalledTimes(1);
    expect(repoMock.listRelationsByEntityIds).toHaveBeenCalledTimes(1);
    expect(repoMock.getEntityWithRelations).not.toHaveBeenCalled();
  });
});
