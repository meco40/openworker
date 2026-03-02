import type { EntityGraphFilter } from '@/server/knowledge/entityGraph';
import type { SqliteKnowledgeRepository } from '@/server/knowledge/sqliteKnowledgeRepository';

export const FILTER: EntityGraphFilter = {
  userId: 'user-1',
  personaId: 'persona-nata',
};

type UpsertEntityInput = Parameters<SqliteKnowledgeRepository['upsertEntity']>[0];
type AddAliasInput = Parameters<SqliteKnowledgeRepository['addAlias']>[0];
type AddRelationInput = Parameters<SqliteKnowledgeRepository['addRelation']>[0];

export function makeEntity(overrides: Partial<UpsertEntityInput>): UpsertEntityInput {
  const { properties, ...rest } = overrides;
  return {
    id: 'entity-default',
    userId: FILTER.userId,
    personaId: FILTER.personaId,
    canonicalName: 'Entity',
    category: 'person',
    owner: 'persona',
    ...rest,
    properties: {
      ...(properties ?? {}),
    },
  };
}

export function makeAlias(entityId: string, overrides: Partial<AddAliasInput> = {}): AddAliasInput {
  return {
    entityId,
    alias: 'Alias',
    aliasType: 'relation',
    owner: 'persona',
    confidence: 0.9,
    ...overrides,
  };
}

export function makeRelation(
  sourceEntityId: string,
  targetEntityId: string,
  overrides: Partial<AddRelationInput> = {},
): AddRelationInput {
  const { properties, ...rest } = overrides;
  return {
    sourceEntityId,
    targetEntityId,
    relationType: 'related_to',
    confidence: 0.9,
    ...rest,
    properties: {
      ...(properties ?? {}),
    },
  };
}
