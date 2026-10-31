import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ searchGraphitiFacts: vi.fn<MockProcedure>() }));

vi.mock('@/server/world-model/graphiti/client', () => ({
  searchGraphitiFacts: mocks.searchGraphitiFacts,
}));

import {
  buildGraphitiQueryVariants,
  deduplicateGraphitiFacts,
  isRelevantRankedGraphitiFact,
  rankGraphitiFacts,
  searchGraphitiFactsWithRerank,
} from '@/server/world-model/graphiti/retrieval';
import type { MockProcedure } from '../../helpers/mockProcedure';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.searchGraphitiFacts.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function candidate(score: number, focusMatchedTokens: string[], provenanceMatch = false) {
  return {
    fact: { fact: 'A fact.' },
    score,
    matchedTokens: [],
    focusMatchedTokens,
    provenanceMatch,
  };
}

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

  it('drops empty and duplicate query terms and returns no variants for blank text', () => {
    expect(buildGraphitiQueryVariants({ text: '  ' })).toEqual([]);
    expect(
      buildGraphitiQueryVariants({
        text: ' Alice   owns the project ',
        terms: ['', 'Alice', 'alice'],
        aliases: ['', 'Alicia', 'alicia'],
      }),
    ).toEqual(['Alice owns the project', 'Alice owns project', 'Alice owns project Alicia']);
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

  it('returns no ranked facts when the query contains only stop words', () => {
    expect(rankGraphitiFacts({ text: 'the und ist' }, [{ fact: 'A useful fact.' }])).toEqual([]);
  });

  it('orders equal-score facts by their normalized text', () => {
    const ranked = rankGraphitiFacts({ text: 'widget' }, [
      { fact: 'Zebra planning note' },
      { fact: 'Alpha planning note' },
    ]);

    expect(ranked.map(({ fact }) => fact.fact)).toEqual([
      'Alpha planning note',
      'Zebra planning note',
    ]);
  });

  it('uses prefix matches, phrase matches, and target provenance in scores', () => {
    const ranked = rankGraphitiFacts(
      { text: 'Alice owns BetaClaw project', terms: ['Alice', 'BetaClaw'] },
      [
        {
          fact: 'Alice owns BetaClaw project',
          targetNodeUuid: 'project:betaclaw',
        },
        { fact: 'Alice is responsibility for the BetaClaw project' },
      ],
      { expectedTargetNodeUuid: 'project:betaclaw' },
    );

    expect(ranked[0]).toMatchObject({
      fact: { targetNodeUuid: 'project:betaclaw' },
      provenanceMatch: true,
      score: 1,
    });
    expect(ranked[1]?.matchedTokens).toContain('alice');
    expect(
      rankGraphitiFacts({ text: 'responsible' }, [{ fact: 'responsibility' }])[0]?.matchedTokens,
    ).toEqual(['responsible']);
  });

  it('applies relevance thresholds differently for focused and broad matches', () => {
    expect(isRelevantRankedGraphitiFact(candidate(0, [], true))).toBe(true);
    expect(isRelevantRankedGraphitiFact(candidate(0.3, ['one', 'two']))).toBe(true);
    expect(isRelevantRankedGraphitiFact(candidate(0.29, ['one', 'two']))).toBe(false);
    expect(isRelevantRankedGraphitiFact(candidate(0.44, ['one']))).toBe(false);
    expect(isRelevantRankedGraphitiFact(candidate(0.45, ['one']))).toBe(true);
  });

  it('runs bounded search variants, reranks, and filters irrelevant facts', async () => {
    vi.stubEnv('GRAPHITI_SEARCH_CANDIDATES', 'not-a-number');
    vi.stubEnv('GRAPHITI_SEARCH_RESULTS', '0');
    vi.stubEnv('GRAPHITI_QUERY_VARIANTS', 'not-a-number');
    mocks.searchGraphitiFacts.mockResolvedValue([
      { uuid: 'relevant', fact: 'Alice owns BetaClaw project' },
      { uuid: 'noise', fact: 'Unrelated weather report for tomorrow' },
    ]);

    await expect(
      searchGraphitiFactsWithRerank('scope-1', {
        text: 'Alice owns BetaClaw project',
        terms: ['Alice', 'BetaClaw'],
        aliases: ['Alicia'],
      }),
    ).resolves.toMatchObject([{ uuid: 'relevant' }]);

    expect(mocks.searchGraphitiFacts).toHaveBeenCalledTimes(3);
    for (const call of mocks.searchGraphitiFacts.mock.calls) {
      expect(call[0]).toBe('scope-1');
      expect(call[2]).toBe(20);
    }
  });

  it('clamps explicit search limits and skips remote work for an empty query', async () => {
    mocks.searchGraphitiFacts.mockResolvedValue([
      { uuid: 'first', fact: 'Alpha planning decision' },
      { uuid: 'second', fact: 'Alpha planning commitment' },
    ]);
    await expect(
      searchGraphitiFactsWithRerank(
        'scope-2',
        { text: 'Alpha planning decision' },
        { maxCandidates: 1000, maxResults: 0, maxQueryVariants: 0 },
      ),
    ).resolves.toHaveLength(1);
    expect(mocks.searchGraphitiFacts).toHaveBeenCalledOnce();
    expect(mocks.searchGraphitiFacts).toHaveBeenCalledWith(
      'scope-2',
      'Alpha planning decision',
      100,
    );

    mocks.searchGraphitiFacts.mockClear();
    await expect(searchGraphitiFactsWithRerank('scope-2', { text: '   ' })).resolves.toEqual([]);
    expect(mocks.searchGraphitiFacts).not.toHaveBeenCalled();
  });

  it('propagates failures from the Graphiti search client', async () => {
    mocks.searchGraphitiFacts.mockRejectedValue(new Error('Graphiti unavailable'));

    await expect(
      searchGraphitiFactsWithRerank('scope-1', { text: 'Alice owns the project' }),
    ).rejects.toThrow('Graphiti unavailable');
  });
});
