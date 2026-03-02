import { NextResponse } from 'next/server';
import type {
  EntityCategory,
  EntityGraphFilter,
  EntityRelation,
} from '@/server/knowledge/entityGraph';
import type { KnowledgeRepository } from '@/server/knowledge/repository';
import { getKnowledgeRepository } from '@/server/knowledge/runtime';
import { parseBoundedIntOrNull } from '@/server/http/params';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_NODE_LIMIT = 250;
const MAX_NODE_LIMIT = 500;
const DEFAULT_EDGE_LIMIT = 2_000;
const MAX_EDGE_LIMIT = 5_000;

class ValidationError extends Error {}

type KnowledgeGraphNode = {
  id: string;
  label: string;
  category: EntityCategory;
  owner: 'persona' | 'user' | 'shared';
  aliasCount: number;
};

type KnowledgeGraphEdge = {
  id: string;
  source: string;
  target: string;
  relationType: string;
  confidence: number;
};

type KnowledgeGraphBatchRepository = KnowledgeRepository & {
  getAliasCountsByEntityIds?: (entityIds: string[]) => Record<string, number>;
  listRelationsByEntityIds?: (entityIds: string[]) => EntityRelation[];
};

function parseRequiredPersonaId(raw: string | null): string {
  const personaId = String(raw || '').trim();
  if (!personaId) {
    throw new ValidationError('personaId is required.');
  }
  return personaId;
}

function parseGraphLimit(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = parseBoundedIntOrNull(raw, fallback, min, max);
  if (parsed === null) {
    throw new ValidationError('limit must be a number.');
  }
  return parsed;
}

function normalizeEdgeId(relation: EntityRelation): string {
  return (
    String(relation.id || '').trim() ||
    `${relation.sourceEntityId}:${relation.relationType}:${relation.targetEntityId}`
  );
}

export const GET = withUserContext(async ({ request, userContext }) => {
  const startedAt = Date.now();
  try {
    const url = new URL(request.url);
    const personaId = parseRequiredPersonaId(url.searchParams.get('personaId'));
    const nodeLimit = parseGraphLimit(
      url.searchParams.get('limit'),
      DEFAULT_NODE_LIMIT,
      1,
      MAX_NODE_LIMIT,
    );
    const edgeLimit = parseGraphLimit(
      url.searchParams.get('edgeLimit'),
      DEFAULT_EDGE_LIMIT,
      1,
      MAX_EDGE_LIMIT,
    );

    const repo = getKnowledgeRepository() as KnowledgeGraphBatchRepository;
    const filter: EntityGraphFilter = {
      userId: userContext.userId,
      personaId,
    };

    const probedEntities = repo.listEntities(filter, nodeLimit + 1);
    const nodeTruncated = probedEntities.length > nodeLimit;
    const entities = probedEntities.slice(0, nodeLimit);

    const nodes: KnowledgeGraphNode[] = [];
    const categoryCounts: Record<string, number> = {};
    const relationById = new Map<string, EntityRelation>();
    const entityIds = entities.map((entity) => entity.id);

    if (repo.getAliasCountsByEntityIds && repo.listRelationsByEntityIds) {
      const aliasCountsByEntityId = repo.getAliasCountsByEntityIds(entityIds);
      const scopedRelations = repo.listRelationsByEntityIds(entityIds);

      for (const entity of entities) {
        nodes.push({
          id: entity.id,
          label: entity.canonicalName,
          category: entity.category,
          owner: entity.owner,
          aliasCount: aliasCountsByEntityId[entity.id] || 0,
        });
        categoryCounts[entity.category] = (categoryCounts[entity.category] || 0) + 1;
      }

      for (const relation of scopedRelations) {
        relationById.set(normalizeEdgeId(relation), relation);
      }
    } else {
      for (const entity of entities) {
        const withRelations = repo.getEntityWithRelations(entity.id);
        nodes.push({
          id: entity.id,
          label: entity.canonicalName,
          category: entity.category,
          owner: entity.owner,
          aliasCount: withRelations.aliases.length,
        });
        categoryCounts[entity.category] = (categoryCounts[entity.category] || 0) + 1;

        for (const relation of withRelations.relations) {
          relationById.set(normalizeEdgeId(relation), relation);
        }
      }
    }

    const nodeIdSet = new Set(nodes.map((node) => node.id));
    const allScopedEdges = Array.from(relationById.values()).filter(
      (relation) =>
        nodeIdSet.has(relation.sourceEntityId) &&
        nodeIdSet.has(relation.targetEntityId) &&
        relation.sourceEntityId !== relation.targetEntityId,
    );
    const edgeTruncated = allScopedEdges.length > edgeLimit;
    const edges: KnowledgeGraphEdge[] = allScopedEdges.slice(0, edgeLimit).map((relation) => ({
      id: normalizeEdgeId(relation),
      source: relation.sourceEntityId,
      target: relation.targetEntityId,
      relationType: relation.relationType,
      confidence: relation.confidence,
    }));

    const durationMs = Date.now() - startedAt;
    console.info(
      JSON.stringify({
        event: 'knowledge_graph_response',
        userId: userContext.userId,
        personaId,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        nodeLimit,
        edgeLimit,
        nodeTruncated,
        edgeTruncated,
        durationMs,
      }),
    );

    return NextResponse.json({
      ok: true,
      graph: {
        nodes,
        edges,
      },
      stats: {
        nodes: nodes.length,
        edges: edges.length,
        categories: categoryCounts,
        truncated: nodeTruncated || edgeTruncated,
      },
      meta: {
        durationMs,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message =
      error instanceof Error ? error.message : 'Unable to build knowledge graph response.';
    const status = error instanceof ValidationError ? 400 : 500;
    console.warn(
      JSON.stringify({
        event: 'knowledge_graph_error',
        durationMs,
        status,
        message,
      }),
    );
    return NextResponse.json({ ok: false, error: message }, { status });
  }
});
