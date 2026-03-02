import { describe, expect, it } from 'vitest';
import { FILTER, makeAlias, makeEntity } from './fixtures';
import { setupEntityGraphHarness } from './harness';

const { getRepo } = setupEntityGraphHarness();

describe('Entity Graph — resolveEntity', () => {
  it('exact name match returns confidence 1.0', () => {
    const repo = getRepo();
    repo.upsertEntity(
      makeEntity({
        id: 'ent-1',
        canonicalName: 'Max',
      }),
    );

    const result = repo.resolveEntity('Max', FILTER);
    expect(result).not.toBeNull();
    expect(result!.entity.canonicalName).toBe('Max');
    expect(result!.matchType).toBe('exact_name');
    expect(result!.confidence).toBe(1.0);
  });

  it('alias match via relation word "Bruder" finds Max', () => {
    const repo = getRepo();
    const entity = repo.upsertEntity(
      makeEntity({
        id: 'ent-1',
        canonicalName: 'Max',
      }),
    );
    repo.addAlias(makeAlias(entity.id, { alias: 'Bruder' }));

    const result = repo.resolveEntity('Bruder', FILTER);
    expect(result).not.toBeNull();
    expect(result!.entity.canonicalName).toBe('Max');
    expect(result!.matchType).toBe('alias');
    expect(result!.confidence).toBe(0.9);
  });

  it('possessive normalization: "mein Bruder" strips possessive', () => {
    const repo = getRepo();
    const entity = repo.upsertEntity(
      makeEntity({
        id: 'ent-1',
        canonicalName: 'Max',
      }),
    );
    repo.addAlias(makeAlias(entity.id, { alias: 'Bruder' }));

    const result = repo.resolveEntity('mein Bruder', FILTER);
    expect(result).not.toBeNull();
    expect(result!.entity.canonicalName).toBe('Max');
  });

  it('returns null for unknown text', () => {
    const repo = getRepo();
    const result = repo.resolveEntity('UnbekanntePerson', FILTER);
    expect(result).toBeNull();
  });

  it('fuzzy match by prefix', () => {
    const repo = getRepo();
    const entity = repo.upsertEntity(
      makeEntity({
        id: 'ent-1',
        canonicalName: 'Maximilian',
      }),
    );
    repo.addAlias(
      makeAlias(entity.id, {
        alias: 'Maxi',
        aliasType: 'abbreviation',
        confidence: 0.7,
      }),
    );

    const result = repo.resolveEntity('Maxi', FILTER);
    expect(result).not.toBeNull();
    expect(result!.entity.canonicalName).toBe('Maximilian');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.6);
  });
});

describe('Entity Graph — resolveEntityByRelation', () => {
  it('resolves persona-owned Bruder but not user-owned', () => {
    const repo = getRepo();
    const maxEntity = repo.upsertEntity(
      makeEntity({
        id: 'ent-1',
        canonicalName: 'Max',
        owner: 'persona',
      }),
    );
    repo.addAlias(
      makeAlias(maxEntity.id, {
        alias: 'Bruder',
        owner: 'persona',
      }),
    );

    const userBro = repo.upsertEntity(
      makeEntity({
        id: 'ent-2',
        canonicalName: 'UserBruder',
        owner: 'user',
      }),
    );
    repo.addAlias(
      makeAlias(userBro.id, {
        alias: 'Bruder',
        owner: 'user',
      }),
    );

    const personaResult = repo.resolveEntityByRelation('Bruder', 'persona', FILTER);
    expect(personaResult).not.toBeNull();
    expect(personaResult!.entity.canonicalName).toBe('Max');

    const userResult = repo.resolveEntityByRelation('Bruder', 'user', FILTER);
    expect(userResult).not.toBeNull();
    expect(userResult!.entity.canonicalName).toBe('UserBruder');
  });
});
