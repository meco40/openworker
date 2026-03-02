import { describe, expect, it } from 'vitest';
import { makeEntity, makeRelation } from './fixtures';
import { setupEntityGraphHarness } from './harness';

const { getRepo } = setupEntityGraphHarness();

describe('Entity Graph — Relations', () => {
  it('addRelation + getEntityWithRelations returns full graph', () => {
    const repo = getRepo();
    const notes2 = repo.upsertEntity(
      makeEntity({
        id: 'ent-proj',
        canonicalName: 'Notes2',
        category: 'project',
        owner: 'shared',
      }),
    );
    const nextjs = repo.upsertEntity(
      makeEntity({
        id: 'ent-fw',
        canonicalName: 'Next.js',
        category: 'concept',
        owner: 'shared',
      }),
    );

    repo.addRelation(
      makeRelation(notes2.id, nextjs.id, {
        relationType: 'framework',
        properties: { version: '16' },
        confidence: 0.95,
      }),
    );

    const result = repo.getEntityWithRelations(notes2.id);
    expect(result.entity.canonicalName).toBe('Notes2');
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0].relationType).toBe('framework');
    expect(result.relations[0].targetEntityId).toBe(nextjs.id);
  });

  it('getRelatedEntities traverses one hop', () => {
    const repo = getRepo();
    const notes2 = repo.upsertEntity(
      makeEntity({
        id: 'ent-proj',
        canonicalName: 'Notes2',
        category: 'project',
        owner: 'shared',
      }),
    );
    const nextjs = repo.upsertEntity(
      makeEntity({
        id: 'ent-fw',
        canonicalName: 'Next.js',
        category: 'concept',
        owner: 'shared',
      }),
    );
    const prisma = repo.upsertEntity(
      makeEntity({
        id: 'ent-orm',
        canonicalName: 'Prisma',
        category: 'concept',
        owner: 'shared',
      }),
    );

    repo.addRelation(makeRelation(notes2.id, nextjs.id, { relationType: 'framework' }));
    repo.addRelation(makeRelation(notes2.id, prisma.id, { relationType: 'orm' }));

    const related = repo.getRelatedEntities(notes2.id);
    expect(related).toHaveLength(2);

    const names = related.map((entity) => entity.canonicalName).sort();
    expect(names).toEqual(['Next.js', 'Prisma']);

    const frameworks = repo.getRelatedEntities(notes2.id, 'framework');
    expect(frameworks).toHaveLength(1);
    expect(frameworks[0].canonicalName).toBe('Next.js');
  });

  it('findPath finds a 2-hop path', () => {
    const repo = getRepo();
    const nata = repo.upsertEntity(
      makeEntity({
        id: 'ent-nata',
        canonicalName: 'Nata',
        category: 'person',
        owner: 'shared',
      }),
    );
    const max = repo.upsertEntity(
      makeEntity({
        id: 'ent-max',
        canonicalName: 'Max',
        category: 'person',
        owner: 'persona',
      }),
    );
    const lisa = repo.upsertEntity(
      makeEntity({
        id: 'ent-lisa',
        canonicalName: 'Lisa',
        category: 'person',
        owner: 'persona',
      }),
    );

    repo.addRelation(makeRelation(nata.id, max.id, { relationType: 'bruder' }));
    repo.addRelation(makeRelation(max.id, lisa.id, { relationType: 'freundin', confidence: 0.85 }));

    const path = repo.findPath(nata.id, lisa.id, 3);
    expect(path).toHaveLength(2);
    expect(path[0].relationType).toBe('bruder');
    expect(path[1].relationType).toBe('freundin');
  });

  it('findPath returns empty when no path exists', () => {
    const repo = getRepo();
    const nata = repo.upsertEntity(
      makeEntity({
        id: 'ent-nata',
        canonicalName: 'Nata',
        category: 'person',
        owner: 'shared',
      }),
    );
    const unrelated = repo.upsertEntity(
      makeEntity({
        id: 'ent-x',
        canonicalName: 'Unrelated',
        category: 'person',
        owner: 'shared',
      }),
    );

    const path = repo.findPath(nata.id, unrelated.id, 3);
    expect(path).toHaveLength(0);
  });

  it('respects maxDepth in findPath traversal', () => {
    const repo = getRepo();
    const a = repo.upsertEntity(
      makeEntity({
        id: 'ent-a',
        canonicalName: 'A',
        category: 'concept',
        owner: 'shared',
      }),
    );
    const b = repo.upsertEntity(
      makeEntity({
        id: 'ent-b',
        canonicalName: 'B',
        category: 'concept',
        owner: 'shared',
      }),
    );
    const c = repo.upsertEntity(
      makeEntity({
        id: 'ent-c',
        canonicalName: 'C',
        category: 'concept',
        owner: 'shared',
      }),
    );

    repo.addRelation(makeRelation(a.id, b.id, { relationType: 'step' }));
    repo.addRelation(makeRelation(b.id, c.id, { relationType: 'step' }));

    expect(repo.findPath(a.id, c.id, 1)).toHaveLength(0);
    expect(repo.findPath(a.id, c.id, 2)).toHaveLength(2);
  });
});
