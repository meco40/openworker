/**
 * Tests for EntityExtractor: normalizeEntities, validateOwner, mergeWithExisting
 */
import { describe, expect, it } from 'vitest';
import { EntityExtractor, isRelationWord } from '../../../src/server/knowledge/entityExtractor';
import type { ExtractedEntity } from '../../../src/server/knowledge/entityExtractor';
import type { StoredMessage } from '../../../src/server/channels/messages/repository';
import type { EntityAlias, KnowledgeEntity } from '../../../src/server/knowledge/entityGraph';

function makeMsg(seq: number, role: string, content: string): StoredMessage {
  return {
    id: `msg-${seq}`,
    conversationId: 'conv-1',
    role,
    content,
    seq,
    createdAt: '2026-02-16T14:00:00Z',
  } as StoredMessage;
}

describe('EntityExtractor.normalizeEntities', () => {
  const extractor = new EntityExtractor();

  it('normalizes a valid person entity with aliases and properties', () => {
    const raw = [
      {
        name: 'Max',
        category: 'person',
        owner: 'persona',
        aliases: ['mein Bruder', 'Bruder'],
        relations: [{ targetName: 'Nata', relationType: 'bruder', direction: 'incoming' }],
        properties: { nett: 'ja' },
        sourceSeq: [10],
      },
    ];
    const messages = [makeMsg(10, 'assistant', 'Max mein Bruder ist sehr nett')];

    const result = extractor.normalizeEntities(raw, messages);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Max');
    expect(result[0].category).toBe('person');
    expect(result[0].owner).toBe('persona');
    expect(result[0].aliases).toEqual(['mein Bruder', 'Bruder']);
    expect(result[0].properties).toEqual({ nett: 'ja' });
    expect(result[0].relations).toHaveLength(1);
    expect(result[0].relations[0].relationType).toBe('bruder');
  });

  it('filters entries with empty name', () => {
    const raw = [
      {
        name: '',
        category: 'person',
        owner: 'persona',
        aliases: [],
        relations: [],
        properties: {},
        sourceSeq: [],
      },
    ];
    const result = extractor.normalizeEntities(raw, []);
    expect(result).toHaveLength(0);
  });

  it('filters entries with invalid category', () => {
    const raw = [
      {
        name: 'X',
        category: 'invalid',
        owner: 'persona',
        aliases: [],
        relations: [],
        properties: {},
        sourceSeq: [],
      },
    ];
    const result = extractor.normalizeEntities(raw, []);
    expect(result).toHaveLength(0);
  });

  it('sets owner=user when source message is from user', () => {
    const raw = [
      {
        name: 'UserBruder',
        category: 'person',
        owner: 'persona', // LLM says persona, but message is from user
        aliases: [],
        relations: [],
        properties: {},
        sourceSeq: [5],
      },
    ];
    const messages = [makeMsg(5, 'user', 'Ich habe mit meinem Bruder gesprochen')];
    const result = extractor.normalizeEntities(raw, messages);
    expect(result).toHaveLength(1);
    expect(result[0].owner).toBe('user');
  });
});

describe('EntityExtractor.validateOwner', () => {
  const extractor = new EntityExtractor();

  it('overrides persona to user when message role is user', () => {
    const entity: ExtractedEntity = {
      name: 'Test',
      category: 'person',
      owner: 'persona',
      aliases: [],
      relations: [],
      properties: {},
      sourceSeq: [1],
    };
    const result = extractor.validateOwner(entity, [makeMsg(1, 'user', 'text')]);
    expect(result.owner).toBe('user');
  });

  it('preserves shared owner even if single role', () => {
    const entity: ExtractedEntity = {
      name: 'Berlin',
      category: 'place',
      owner: 'shared',
      aliases: [],
      relations: [],
      properties: {},
      sourceSeq: [1],
    };
    const result = extractor.validateOwner(entity, [makeMsg(1, 'user', 'in Berlin')]);
    expect(result.owner).toBe('shared');
  });
});

describe('EntityExtractor.mergeWithExisting', () => {
  const extractor = new EntityExtractor();

  it('returns create when no existing entity', () => {
    const entity: ExtractedEntity = {
      name: 'Max',
      category: 'person',
      owner: 'persona',
      aliases: ['Bruder'],
      relations: [],
      properties: { nett: 'ja' },
      sourceSeq: [10],
    };
    const verdict = extractor.mergeWithExisting(entity, null, []);
    expect(verdict.action).toBe('create');
  });

  it('returns merge with new aliases and properties', () => {
    const entity: ExtractedEntity = {
      name: 'Max',
      category: 'person',
      owner: 'persona',
      aliases: ['Bruder', 'mein Bruder', 'Maximilian'],
      relations: [],
      properties: { beruf: 'Ingenieur' },
      sourceSeq: [20],
    };
    const existing: KnowledgeEntity = {
      id: 'ent-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Max',
      category: 'person',
      owner: 'persona',
      properties: { nett: 'ja' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const existingAliases: EntityAlias[] = [
      {
        id: 'a-1',
        entityId: 'ent-1',
        alias: 'Bruder',
        aliasType: 'relation',
        owner: 'persona',
        confidence: 0.9,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];

    const verdict = extractor.mergeWithExisting(entity, existing, existingAliases);
    expect(verdict.action).toBe('merge');
    expect(verdict.newAliases).toEqual(['mein Bruder', 'Maximilian']);
    expect(verdict.updates?.properties).toEqual({ beruf: 'Ingenieur' });
  });

  it('returns merge with no updates when nothing new', () => {
    const entity: ExtractedEntity = {
      name: 'Max',
      category: 'person',
      owner: 'persona',
      aliases: ['Bruder'],
      relations: [],
      properties: { nett: 'ja' },
      sourceSeq: [20],
    };
    const existing: KnowledgeEntity = {
      id: 'ent-1',
      userId: 'user-1',
      personaId: 'persona-nata',
      canonicalName: 'Max',
      category: 'person',
      owner: 'persona',
      properties: { nett: 'ja' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const existingAliases: EntityAlias[] = [
      {
        id: 'a-1',
        entityId: 'ent-1',
        alias: 'Bruder',
        aliasType: 'relation',
        owner: 'persona',
        confidence: 0.9,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];

    const verdict = extractor.mergeWithExisting(entity, existing, existingAliases);
    expect(verdict.action).toBe('merge');
    expect(verdict.newAliases).toBeUndefined();
    expect(verdict.updates).toBeUndefined();
  });
});

describe('isRelationWord', () => {
  it('returns true for "Bruder"', () => {
    expect(isRelationWord('Bruder')).toBe(true);
  });

  it('returns true for "mein Bruder" (strips possessive)', () => {
    expect(isRelationWord('mein Bruder')).toBe(true);
  });

  it('returns false for "Max"', () => {
    expect(isRelationWord('Max')).toBe(false);
  });

  it('returns false for "Maximilian"', () => {
    expect(isRelationWord('Maximilian')).toBe(false);
  });
});
