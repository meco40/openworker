import { describe, expect, it } from 'vitest';
import { FILTER, makeAlias, makeEntity } from './fixtures';
import { setupEntityGraphHarness } from './harness';

const { getRepo } = setupEntityGraphHarness();

describe('Entity Graph — repository edge branches', () => {
  it('listEntities supports owner filter', () => {
    const repo = getRepo();
    repo.upsertEntity(
      makeEntity({
        id: 'ent-owner-1',
        canonicalName: 'PersonaOwned',
        owner: 'persona',
      }),
    );
    repo.upsertEntity(
      makeEntity({
        id: 'ent-owner-2',
        canonicalName: 'UserOwned',
        owner: 'user',
      }),
    );

    const userOwned = repo.listEntities({ ...FILTER, owner: 'user' });
    expect(userOwned).toHaveLength(1);
    expect(userOwned[0].canonicalName).toBe('UserOwned');
  });

  it('returns alias counts for empty and populated id lists', () => {
    const repo = getRepo();
    expect(repo.getAliasCountsByEntityIds([])).toEqual({});

    const entity = repo.upsertEntity(
      makeEntity({
        id: 'ent-alias-count',
        canonicalName: 'Counted',
      }),
    );
    repo.addAlias(
      makeAlias(entity.id, { alias: 'One', aliasType: 'abbreviation', confidence: 0.8 }),
    );
    repo.addAlias(
      makeAlias(entity.id, { alias: 'Two', aliasType: 'abbreviation', confidence: 0.8 }),
    );

    const counts = repo.getAliasCountsByEntityIds([entity.id, 'missing']);
    expect(counts[entity.id]).toBe(2);
    expect(counts.missing).toBe(0);
  });

  it('handles empty relation lists and throws for missing entity details', () => {
    const repo = getRepo();
    expect(repo.listRelationsByEntityIds([])).toEqual([]);
    expect(() => repo.getEntityWithRelations('missing-id')).toThrow('Entity missing-id not found');
  });

  it('returns empty related entities and null relation lookup when nothing matches', () => {
    const repo = getRepo();
    const entity = repo.upsertEntity(
      makeEntity({
        id: 'ent-orphan',
        canonicalName: 'Orphan',
        owner: 'shared',
      }),
    );

    expect(repo.getRelatedEntities(entity.id, 'friend')).toEqual([]);
    expect(repo.resolveEntityByRelation('unknown', 'persona', FILTER)).toBeNull();
  });
});
