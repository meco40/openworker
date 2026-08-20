import { describe, expect, it } from 'vitest';
import {
  buildGraphitiQueryVariants,
  deduplicateGraphitiFacts,
  isRelevantRankedGraphitiFact,
  rankGraphitiFacts,
} from '@/server/world-model/graphiti/retrieval';

describe('world-model Graphiti retrieval', () => {
  it('builds bounded canonical, token, and alias query variants', () => {
    const variants = buildGraphitiQueryVariants(
      {
        text: 'Alice is responsible for the World Model',
        terms: ['Alice', 'responsible_for', 'World Model'],
        aliases: ['Alicia'],
      },
      3,
    );

    expect(variants[0]).toBe('Alice is responsible for the World Model');
    expect(variants).toHaveLength(3);
    expect(variants[1]).toContain('responsible_for');
    expect(variants[2]).toContain('Alicia');
  });

  it('deduplicates repeated Graphiti facts by UUID and normalized content', () => {
    const facts = [
      { uuid: 'fact-1', fact: 'Alice is responsible for the World Model.' },
      { uuid: 'fact-1', fact: 'Alice is responsible for the World Model.' },
      { fact: '  Alice is responsible for the World Model.  ' },
      { uuid: 'fact-2', fact: 'Bob owns the cinema project.' },
    ];

    expect(deduplicateGraphitiFacts(facts)).toHaveLength(2);
  });

  it('ranks focused facts above lexical noise and honors provenance', () => {
    const candidates = rankGraphitiFacts(
      {
        text: 'Alice responsible World Model',
        terms: ['Alice', 'responsible_for', 'World Model'],
      },
      [
        { uuid: 'noise', fact: 'The project model has a generic status.' },
        {
          uuid: 'expected',
          fact: 'Alice is responsible for the World Model integration.',
          sourceNodeUuid: 'ent:Alice:scope',
        },
      ],
      { expectedSourceNodeUuid: 'ent:Alice:scope' },
    );

    expect(candidates[0]?.fact.uuid).toBe('expected');
    expect(candidates[0]?.provenanceMatch).toBe(true);
    expect(candidates[0]?.focusMatchedTokens.length).toBeGreaterThanOrEqual(2);
    expect(isRelevantRankedGraphitiFact(candidates[0]!)).toBe(true);
  });
});
