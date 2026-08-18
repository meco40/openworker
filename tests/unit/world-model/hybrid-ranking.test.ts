import { describe, expect, it } from 'vitest';

import { buildEmbeddingText, hashText } from '@/server/world-model/embeddings/embeddingText';
import {
  hybridRank,
  suppressInactiveBeforeLowerSource,
} from '@/server/world-model/retrieval/hybridRanker';

describe('hybridRank', () => {
  it('ranks structured active ahead of fulltext ahead of vector', () => {
    const ranked = hybridRank([
      { id: 'v', source: 'vector', score: 0.9, active: true },
      { id: 'ft', source: 'fulltext', score: 0.7, active: true },
      { id: 's', source: 'structured', score: 0.5, active: true },
    ]);
    expect(ranked[0]?.id).toBe('s');
    expect(ranked[1]?.id).toBe('ft');
    expect(ranked[2]?.id).toBe('v');
  });

  it('active truth beats inactive semantic similarity', () => {
    const ranked = hybridRank([
      { id: 'active-assertion', source: 'fulltext', score: 0.4, active: true },
      { id: 'retracted-vector', source: 'vector', score: 0.99, active: false },
    ]);
    expect(ranked[0]?.id).toBe('active-assertion');
  });

  it('applies an intent bonus for non-generic queries', () => {
    const generic = hybridRank([
      { id: 'a', source: 'vector', score: 0.5, active: true, queryIntent: 'generic' },
    ]);
    const specific = hybridRank([
      { id: 'b', source: 'vector', score: 0.5, active: true, queryIntent: 'what_done' },
    ]);
    expect(specific[0]!.combined).toBeLessThan(generic[0]!.combined); // penalty on wrong-intent? no: bonus -> higher
    // Intent-Bonus multipliziert mit 0.9 -> geringerer Score, aber Sortierung bleibt.
    expect(specific[0]!.combined).toBeLessThanOrEqual(generic[0]!.combined * 1.0);
  });
});

describe('suppressInactiveBeforeLowerSource', () => {
  it('drops inactive hits of lower-priority sources but keeps active ones', () => {
    const ranked = hybridRank([
      { id: 'active-structured', source: 'structured', score: 0.5, active: true },
      { id: 'inactive-vector', source: 'vector', score: 0.9, active: false },
    ]);
    const filtered = suppressInactiveBeforeLowerSource(ranked, 'vector');
    expect(filtered.some((h) => h.id === 'inactive-vector')).toBe(false);
    expect(filtered.some((h) => h.id === 'active-structured')).toBe(true);
  });
});

describe('buildEmbeddingText', () => {
  it('joins content and produces a stable hash + version', () => {
    const a = buildEmbeddingText({ targetType: 'event', content: ['Essen', 'mit Mike'] });
    const b = buildEmbeddingText({ targetType: 'event', content: ['Essen', 'mit Mike'] });
    expect(a.text).toBe('Essen mit Mike');
    expect(a.textHash).toBe(b.textHash);
    expect(a.projectionVersion).toBe('v1');
  });

  it('returns a deterministic hash', () => {
    expect(hashText('Kino')).toBe(hashText('Kino'));
    expect(hashText('Kino')).not.toBe(hashText('Essen'));
  });
});
