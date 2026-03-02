import { describe, expect, it } from 'vitest';
import { FILTER, makeAlias, makeEntity } from './fixtures';
import { setupEntityGraphHarness } from './harness';

const { getRepo } = setupEntityGraphHarness();

describe('Entity Graph — CRUD', () => {
  it('upsertEntity stores and returns an entity', () => {
    const repo = getRepo();
    const entity = repo.upsertEntity(
      makeEntity({
        id: 'ent-1',
        canonicalName: 'Max',
        category: 'person',
        owner: 'persona',
        properties: { beruf: 'Ingenieur', alter: '28' },
      }),
    );

    expect(entity.id).toBe('ent-1');
    expect(entity.canonicalName).toBe('Max');
    expect(entity.category).toBe('person');
    expect(entity.owner).toBe('persona');
    expect(entity.properties).toEqual({ beruf: 'Ingenieur', alter: '28' });
  });

  it('updateEntityProperties merges into existing properties', () => {
    const repo = getRepo();
    repo.upsertEntity(
      makeEntity({
        id: 'ent-1',
        canonicalName: 'Max',
        properties: { beruf: 'Ingenieur' },
      }),
    );

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
    const repo = getRepo();
    repo.upsertEntity(
      makeEntity({
        id: 'ent-1',
        canonicalName: 'Max',
        category: 'person',
        owner: 'persona',
      }),
    );
    repo.upsertEntity(
      makeEntity({
        id: 'ent-2',
        canonicalName: 'Berlin',
        category: 'place',
        owner: 'shared',
      }),
    );

    const persons = repo.listEntities({ ...FILTER, category: 'person' });
    expect(persons).toHaveLength(1);
    expect(persons[0].canonicalName).toBe('Max');
  });

  it('deleteEntity cascades to aliases and relations', () => {
    const repo = getRepo();
    const entity = repo.upsertEntity(
      makeEntity({
        id: 'ent-1',
        canonicalName: 'Max',
      }),
    );
    repo.addAlias(makeAlias(entity.id, { alias: 'Bruder' }));

    repo.deleteEntity(entity.id);

    const found = repo.resolveEntity('Max', FILTER);
    expect(found).toBeNull();

    const aliasFallback = repo.resolveEntity('Bruder', FILTER);
    expect(aliasFallback).toBeNull();
  });

  it('deleteEntitiesByName removes matching entities and returns count', () => {
    const repo = getRepo();
    repo.upsertEntity(
      makeEntity({
        id: 'ent-1',
        canonicalName: 'Max',
      }),
    );

    const count = repo.deleteEntitiesByName('Max', FILTER);
    expect(count).toBe(1);

    const remaining = repo.listEntities(FILTER);
    expect(remaining).toHaveLength(0);
  });
});
