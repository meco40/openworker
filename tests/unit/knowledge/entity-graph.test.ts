import { getTestArtifactsRoot } from '../../helpers/testArtifacts';
/**
 * Tests for Entity Graph repository methods:
 * CRUD, alias resolution, relation traversal, owner isolation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { SqliteKnowledgeRepository } from '@/server/knowledge/sqliteKnowledgeRepository';
import type { EntityGraphFilter } from '@/server/knowledge/entityGraph';
import { cleanupSqliteArtifacts } from '../../helpers/sqliteTestArtifacts';

const TEST_DB_DIR = getTestArtifactsRoot();
let dbPath: string;
let repo: SqliteKnowledgeRepository;

const FILTER: EntityGraphFilter = {
  userId: 'user-1',
  personaId: 'persona-nata',
};

beforeEach(() => {
  if (!existsSync(TEST_DB_DIR)) mkdirSync(TEST_DB_DIR, { recursive: true });
  dbPath = `${TEST_DB_DIR}/test-entity-graph-${Date.now()}.db`;
  repo = new SqliteKnowledgeRepository(dbPath);
});

afterEach(() => {
  try {
    repo?.close();
  } catch {
    // ignore close races
  }

  try {
    cleanupSqliteArtifacts(dbPath);
  } catch {
    // ignore Windows EBUSY
  }
});

describe('Entity Graph — CRUD', () => {
  it('upsertEntity stores and returns an entity', () => {
    const entity = repo.upsertEntity({
      id: 'ent-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Max',
      category: 'person',
      owner: 'persona',
      properties: { beruf: 'Ingenieur', alter: '28' },
    });

    expect(entity.id).toBe('ent-1');
    expect(entity.canonicalName).toBe('Max');
    expect(entity.category).toBe('person');
    expect(entity.owner).toBe('persona');
    expect(entity.properties).toEqual({ beruf: 'Ingenieur', alter: '28' });
  });

  it('updateEntityProperties merges into existing properties', () => {
    repo.upsertEntity({
      id: 'ent-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Max',
      category: 'person',
      owner: 'persona',
      properties: { beruf: 'Ingenieur' },
    });

    repo.updateEntityProperties('ent-1', { alter: '28', stadt: 'Berlin' });

    const found = repo.resolveEntity('Max', FILTER);
    expect(found).not.toBeNull();
    expect(found!.entity.properties).toEqual({
      beruf: 'Ingenieur',
      alter: '28',
      stadt: 'Berlin',
    });
  });

  it('listEntities respects filter', () => {
    repo.upsertEntity({
      id: 'ent-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Max',
      category: 'person',
      owner: 'persona',
      properties: {},
    });
    repo.upsertEntity({
      id: 'ent-2',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Berlin',
      category: 'place',
      owner: 'shared',
      properties: {},
    });

    const persons = repo.listEntities({ ...FILTER, category: 'person' });
    expect(persons).toHaveLength(1);
    expect(persons[0].canonicalName).toBe('Max');
  });

  it('deleteEntity cascades to aliases and relations', () => {
    const entity = repo.upsertEntity({
      id: 'ent-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Max',
      category: 'person',
      owner: 'persona',
      properties: {},
    });
    repo.addAlias({
      entityId: entity.id,
      alias: 'Bruder',
      aliasType: 'relation',
      owner: 'persona',
      confidence: 0.9,
    });

    repo.deleteEntity(entity.id);

    const found = repo.resolveEntity('Max', FILTER);
    expect(found).toBeNull();

    const aliasFallback = repo.resolveEntity('Bruder', FILTER);
    expect(aliasFallback).toBeNull();
  });

  it('deleteEntitiesByName removes matching entities and returns count', () => {
    repo.upsertEntity({
      id: 'ent-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Max',
      category: 'person',
      owner: 'persona',
      properties: {},
    });

    const count = repo.deleteEntitiesByName('Max', FILTER);
    expect(count).toBe(1);

    const remaining = repo.listEntities(FILTER);
    expect(remaining).toHaveLength(0);
  });
});

describe('Entity Graph — resolveEntity', () => {
  it('exact name match returns confidence 1.0', () => {
    repo.upsertEntity({
      id: 'ent-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Max',
      category: 'person',
      owner: 'persona',
      properties: {},
    });

    const result = repo.resolveEntity('Max', FILTER);
    expect(result).not.toBeNull();
    expect(result!.entity.canonicalName).toBe('Max');
    expect(result!.matchType).toBe('exact_name');
    expect(result!.confidence).toBe(1.0);
  });

  it('alias match via relation word "Bruder" finds Max', () => {
    const entity = repo.upsertEntity({
      id: 'ent-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Max',
      category: 'person',
      owner: 'persona',
      properties: {},
    });
    repo.addAlias({
      entityId: entity.id,
      alias: 'Bruder',
      aliasType: 'relation',
      owner: 'persona',
      confidence: 0.9,
    });

    const result = repo.resolveEntity('Bruder', FILTER);
    expect(result).not.toBeNull();
    expect(result!.entity.canonicalName).toBe('Max');
    expect(result!.matchType).toBe('alias');
    expect(result!.confidence).toBe(0.9);
  });

  it('possessive normalization: "mein Bruder" strips possessive', () => {
    const entity = repo.upsertEntity({
      id: 'ent-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Max',
      category: 'person',
      owner: 'persona',
      properties: {},
    });
    repo.addAlias({
      entityId: entity.id,
      alias: 'Bruder',
      aliasType: 'relation',
      owner: 'persona',
      confidence: 0.9,
    });

    const result = repo.resolveEntity('mein Bruder', FILTER);
    expect(result).not.toBeNull();
    expect(result!.entity.canonicalName).toBe('Max');
  });

  it('returns null for unknown text', () => {
    const result = repo.resolveEntity('UnbekanntePerson', FILTER);
    expect(result).toBeNull();
  });

  it('fuzzy match by prefix', () => {
    const entity = repo.upsertEntity({
      id: 'ent-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Maximilian',
      category: 'person',
      owner: 'persona',
      properties: {},
    });
    repo.addAlias({
      entityId: entity.id,
      alias: 'Maxi',
      aliasType: 'abbreviation',
      owner: 'persona',
      confidence: 0.7,
    });

    const result = repo.resolveEntity('Maxi', FILTER);
    expect(result).not.toBeNull();
    expect(result!.entity.canonicalName).toBe('Maximilian');
    // abbreviation alias is exact — should be 'alias' not 'fuzzy'
    expect(result!.confidence).toBeGreaterThanOrEqual(0.6);
  });
});

describe('Entity Graph — resolveEntityByRelation', () => {
  it('resolves persona-owned Bruder but not user-owned', () => {
    const maxEntity = repo.upsertEntity({
      id: 'ent-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Max',
      category: 'person',
      owner: 'persona',
      properties: {},
    });
    repo.addAlias({
      entityId: maxEntity.id,
      alias: 'Bruder',
      aliasType: 'relation',
      owner: 'persona',
      confidence: 0.9,
    });

    const userBro = repo.upsertEntity({
      id: 'ent-2',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'UserBruder',
      category: 'person',
      owner: 'user',
      properties: {},
    });
    repo.addAlias({
      entityId: userBro.id,
      alias: 'Bruder',
      aliasType: 'relation',
      owner: 'user',
      confidence: 0.9,
    });

    const personaResult = repo.resolveEntityByRelation('Bruder', 'persona', FILTER);
    expect(personaResult).not.toBeNull();
    expect(personaResult!.entity.canonicalName).toBe('Max');

    const userResult = repo.resolveEntityByRelation('Bruder', 'user', FILTER);
    expect(userResult).not.toBeNull();
    expect(userResult!.entity.canonicalName).toBe('UserBruder');
  });
});

describe('Entity Graph — Relations', () => {
  it('addRelation + getEntityWithRelations returns full graph', () => {
    const notes2 = repo.upsertEntity({
      id: 'ent-proj',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Notes2',
      category: 'project',
      owner: 'shared',
      properties: {},
    });
    const nextjs = repo.upsertEntity({
      id: 'ent-fw',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Next.js',
      category: 'concept',
      owner: 'shared',
      properties: {},
    });

    repo.addRelation({
      sourceEntityId: notes2.id,
      targetEntityId: nextjs.id,
      relationType: 'framework',
      properties: { version: '16' },
      confidence: 0.95,
    });

    const result = repo.getEntityWithRelations(notes2.id);
    expect(result.entity.canonicalName).toBe('Notes2');
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0].relationType).toBe('framework');
    expect(result.relations[0].targetEntityId).toBe(nextjs.id);
  });

  it('getRelatedEntities traverses one hop', () => {
    const notes2 = repo.upsertEntity({
      id: 'ent-proj',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Notes2',
      category: 'project',
      owner: 'shared',
      properties: {},
    });
    const nextjs = repo.upsertEntity({
      id: 'ent-fw',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Next.js',
      category: 'concept',
      owner: 'shared',
      properties: {},
    });
    const prisma = repo.upsertEntity({
      id: 'ent-orm',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Prisma',
      category: 'concept',
      owner: 'shared',
      properties: {},
    });

    repo.addRelation({
      sourceEntityId: notes2.id,
      targetEntityId: nextjs.id,
      relationType: 'framework',
      properties: {},
      confidence: 0.9,
    });
    repo.addRelation({
      sourceEntityId: notes2.id,
      targetEntityId: prisma.id,
      relationType: 'orm',
      properties: {},
      confidence: 0.9,
    });

    const related = repo.getRelatedEntities(notes2.id);
    expect(related).toHaveLength(2);

    const names = related.map((e) => e.canonicalName).sort();
    expect(names).toEqual(['Next.js', 'Prisma']);

    // Filter by relationType
    const frameworks = repo.getRelatedEntities(notes2.id, 'framework');
    expect(frameworks).toHaveLength(1);
    expect(frameworks[0].canonicalName).toBe('Next.js');
  });

  it('findPath finds a 2-hop path', () => {
    const nata = repo.upsertEntity({
      id: 'ent-nata',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Nata',
      category: 'person',
      owner: 'shared',
      properties: {},
    });
    const max = repo.upsertEntity({
      id: 'ent-max',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Max',
      category: 'person',
      owner: 'persona',
      properties: {},
    });
    const lisa = repo.upsertEntity({
      id: 'ent-lisa',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Lisa',
      category: 'person',
      owner: 'persona',
      properties: {},
    });

    repo.addRelation({
      sourceEntityId: nata.id,
      targetEntityId: max.id,
      relationType: 'bruder',
      properties: {},
      confidence: 0.9,
    });
    repo.addRelation({
      sourceEntityId: max.id,
      targetEntityId: lisa.id,
      relationType: 'freundin',
      properties: {},
      confidence: 0.85,
    });

    const path = repo.findPath(nata.id, lisa.id, 3);
    expect(path).toHaveLength(2);
    expect(path[0].relationType).toBe('bruder');
    expect(path[1].relationType).toBe('freundin');
  });

  it('findPath returns empty when no path exists', () => {
    const nata = repo.upsertEntity({
      id: 'ent-nata',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Nata',
      category: 'person',
      owner: 'shared',
      properties: {},
    });
    const unrelated = repo.upsertEntity({
      id: 'ent-x',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Unrelated',
      category: 'person',
      owner: 'shared',
      properties: {},
    });

    const path = repo.findPath(nata.id, unrelated.id, 3);
    expect(path).toHaveLength(0);
  });

  it('respects maxDepth in findPath traversal', () => {
    const a = repo.upsertEntity({
      id: 'ent-a',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'A',
      category: 'concept',
      owner: 'shared',
      properties: {},
    });
    const b = repo.upsertEntity({
      id: 'ent-b',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'B',
      category: 'concept',
      owner: 'shared',
      properties: {},
    });
    const c = repo.upsertEntity({
      id: 'ent-c',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'C',
      category: 'concept',
      owner: 'shared',
      properties: {},
    });

    repo.addRelation({
      sourceEntityId: a.id,
      targetEntityId: b.id,
      relationType: 'step',
      properties: {},
      confidence: 0.9,
    });
    repo.addRelation({
      sourceEntityId: b.id,
      targetEntityId: c.id,
      relationType: 'step',
      properties: {},
      confidence: 0.9,
    });

    expect(repo.findPath(a.id, c.id, 1)).toHaveLength(0);
    expect(repo.findPath(a.id, c.id, 2)).toHaveLength(2);
  });
});

describe('Entity Graph — repository edge branches', () => {
  it('listEntities supports owner filter', () => {
    repo.upsertEntity({
      id: 'ent-owner-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'PersonaOwned',
      category: 'person',
      owner: 'persona',
      properties: {},
    });
    repo.upsertEntity({
      id: 'ent-owner-2',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'UserOwned',
      category: 'person',
      owner: 'user',
      properties: {},
    });

    const userOwned = repo.listEntities({ ...FILTER, owner: 'user' });
    expect(userOwned).toHaveLength(1);
    expect(userOwned[0].canonicalName).toBe('UserOwned');
  });

  it('returns alias counts for empty and populated id lists', () => {
    expect(repo.getAliasCountsByEntityIds([])).toEqual({});

    const entity = repo.upsertEntity({
      id: 'ent-alias-count',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Counted',
      category: 'person',
      owner: 'persona',
      properties: {},
    });
    repo.addAlias({
      entityId: entity.id,
      alias: 'One',
      aliasType: 'abbreviation',
      owner: 'persona',
      confidence: 0.8,
    });
    repo.addAlias({
      entityId: entity.id,
      alias: 'Two',
      aliasType: 'abbreviation',
      owner: 'persona',
      confidence: 0.8,
    });

    const counts = repo.getAliasCountsByEntityIds([entity.id, 'missing']);
    expect(counts[entity.id]).toBe(2);
    expect(counts.missing).toBe(0);
  });

  it('handles empty relation lists and throws for missing entity details', () => {
    expect(repo.listRelationsByEntityIds([])).toEqual([]);
    expect(() => repo.getEntityWithRelations('missing-id')).toThrow('Entity missing-id not found');
  });

  it('returns empty related entities and null relation lookup when nothing matches', () => {
    const entity = repo.upsertEntity({
      id: 'ent-orphan',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Orphan',
      category: 'person',
      owner: 'shared',
      properties: {},
    });

    expect(repo.getRelatedEntities(entity.id, 'friend')).toEqual([]);
    expect(repo.resolveEntityByRelation('unknown', 'persona', FILTER)).toBeNull();
  });
});
