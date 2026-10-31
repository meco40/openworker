import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: { query: vi.fn<MockProcedure>() },
  getWorldModelDb: vi.fn<MockProcedure>(),
  runWithWorldModelScope: vi.fn<MockProcedure>(),
  checkGraphitiHealth: vi.fn<MockProcedure>(),
  graphitiGroupId: vi.fn<MockProcedure>(),
  searchGraphitiFactsWithRerank: vi.fn<MockProcedure>(),
  rankGraphitiFacts: vi.fn<MockProcedure>(),
  isRelevantRankedGraphitiFact: vi.fn<MockProcedure>(),
}));

vi.mock('@/server/world-model/db', () => ({
  getWorldModelDb: mocks.getWorldModelDb,
  runWithWorldModelScope: mocks.runWithWorldModelScope,
}));
vi.mock('@/server/world-model/graphiti/client', () => ({
  checkGraphitiHealth: mocks.checkGraphitiHealth,
  graphitiGroupId: mocks.graphitiGroupId,
}));
vi.mock('@/server/world-model/graphiti/retrieval', () => ({
  searchGraphitiFactsWithRerank: mocks.searchGraphitiFactsWithRerank,
  rankGraphitiFacts: mocks.rankGraphitiFacts,
  isRelevantRankedGraphitiFact: mocks.isRelevantRankedGraphitiFact,
}));

import { evaluateGraphitiValue } from '@/server/world-model/graphiti/evaluator';
import type { MockProcedure } from '../../helpers/mockProcedure';

const scope = { userId: 'user-1', personaId: 'persona-1', workspaceId: 'workspace-1' };
const originalSearchResults = process.env.GRAPHITI_SEARCH_RESULTS;

function target(overrides: Record<string, unknown> = {}) {
  return {
    targetId: 'assertion-1',
    targetKind: 'assertion',
    text: 'Alice works at Acme',
    terms: ['Alice', 'works', 'Acme'],
    aliases: ['A. Smith'],
    sourceName: 'Alice',
    targetName: 'Acme',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.GRAPHITI_SEARCH_RESULTS;
  mocks.db.query.mockReset();
  mocks.getWorldModelDb.mockReturnValue(mocks.db);
  mocks.runWithWorldModelScope.mockImplementation((_scope, callback) => callback());
  mocks.checkGraphitiHealth.mockResolvedValue({ reachable: true });
  mocks.graphitiGroupId.mockReturnValue('group-1');
  mocks.searchGraphitiFactsWithRerank.mockResolvedValue([]);
  mocks.rankGraphitiFacts.mockImplementation((_query, facts) => facts);
  mocks.isRelevantRankedGraphitiFact.mockImplementation((fact) => fact.relevant === true);
});

afterEach(() => {
  if (originalSearchResults === undefined) delete process.env.GRAPHITI_SEARCH_RESULTS;
  else process.env.GRAPHITI_SEARCH_RESULTS = originalSearchResults;
  vi.restoreAllMocks();
});

describe('evaluateGraphitiValue', () => {
  it('returns a fallback result when Graphiti is unavailable', async () => {
    mocks.checkGraphitiHealth.mockResolvedValue({ reachable: false, error: 'Graphiti offline' });
    mocks.db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [target()] });

    const result = await evaluateGraphitiValue(scope);

    expect(mocks.runWithWorldModelScope).toHaveBeenCalledWith(scope, expect.any(Function));
    expect(mocks.db.query).toHaveBeenCalledTimes(2);
    expect(mocks.db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('world_model_graphiti_shadow'),
      ['user-1', 'persona-1', 'workspace-1'],
    );
    expect(result).toMatchObject({
      graphitiReachable: false,
      shadowEdgeCount: 0,
      structuredHitCount: 1,
      evaluatedTargetCount: 1,
      retrievalK: 5,
      recommendation: 'fallback',
      error: 'Graphiti offline',
    });
    expect(mocks.searchGraphitiFactsWithRerank).not.toHaveBeenCalled();
  });

  it('returns shadow when Graphiti is reachable but there are no canonical targets', async () => {
    mocks.db.query
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(evaluateGraphitiValue(scope)).resolves.toMatchObject({
      graphitiReachable: true,
      shadowEdgeCount: 2,
      structuredHitCount: 0,
      evaluatedTargetCount: 0,
      recommendation: 'shadow',
    });
    expect(mocks.searchGraphitiFactsWithRerank).not.toHaveBeenCalled();
  });

  it('measures ranked relevance, provenance, top-k metrics, and node identity', async () => {
    process.env.GRAPHITI_SEARCH_RESULTS = '80';
    const assertion = target();
    const task = target({
      targetId: 'task-1',
      targetKind: 'task',
      text: 'Review contract',
      terms: ['Review', 'contract'],
      aliases: [],
      sourceName: null,
      targetName: null,
    });
    const assertionFacts = [
      { id: 'unrelated', relevant: false, provenanceMatch: false },
      { id: 'rank-two', relevant: true, provenanceMatch: true },
      { id: 'rank-three', relevant: true, provenanceMatch: false },
    ];
    const taskFacts = [{ id: 'task-hit', relevant: true, provenanceMatch: false }];
    mocks.db.query
      .mockResolvedValueOnce({ rows: [{ count: '4' }] })
      .mockResolvedValueOnce({ rows: [assertion, task] });
    mocks.searchGraphitiFactsWithRerank
      .mockResolvedValueOnce(assertionFacts)
      .mockResolvedValueOnce(taskFacts);

    const result = await evaluateGraphitiValue(scope);

    expect(mocks.graphitiGroupId).toHaveBeenCalledWith('user-1', 'persona-1', 'workspace-1');
    expect(mocks.searchGraphitiFactsWithRerank).toHaveBeenNthCalledWith(
      1,
      'group-1',
      { text: assertion.text, terms: assertion.terms, aliases: assertion.aliases },
      {
        maxResults: 50,
        expectedSourceNodeUuid: 'ent:Alice:group-1',
        expectedTargetNodeUuid: 'obj:Acme:group-1',
      },
    );
    expect(mocks.searchGraphitiFactsWithRerank).toHaveBeenNthCalledWith(
      2,
      'group-1',
      { text: task.text, terms: task.terms, aliases: task.aliases },
      {
        maxResults: 50,
        expectedSourceNodeUuid: undefined,
        expectedTargetNodeUuid: undefined,
      },
    );
    expect(mocks.rankGraphitiFacts).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      graphitiReachable: true,
      shadowEdgeCount: 4,
      structuredHitCount: 2,
      evaluatedTargetCount: 2,
      graphitiFactCount: 4,
      relevantFactCount: 3,
      matchedStructuredCount: 2,
      provenanceMatchCount: 1,
      retrievalK: 50,
      precision: 0.75,
      recall: 1,
      precisionAt1: 0.5,
      recallAt1: 0.5,
      precisionAt3: 0.75,
      recallAt3: 1,
      precisionAtK: 0.75,
      recallAtK: 1,
      mrr: 0.75,
      overlapRate: 1,
      recommendation: 'shadow',
    });
  });

  it('enables the projection when precision and recall both pass the quality gate', async () => {
    process.env.GRAPHITI_SEARCH_RESULTS = '3';
    mocks.db.query
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [target({ sourceName: null, targetName: null })] });
    mocks.searchGraphitiFactsWithRerank.mockResolvedValueOnce([
      { id: 'relevant', relevant: true, provenanceMatch: true },
    ]);

    const result = await evaluateGraphitiValue(scope);

    expect(result).toMatchObject({
      retrievalK: 5,
      precision: 1,
      recall: 1,
      precisionAt1: 1,
      recallAt1: 1,
      precisionAt3: 1,
      recallAt3: 1,
      mrr: 1,
      recommendation: 'enable',
    });
  });

  it('keeps zero precision metrics when Graphiti returns no facts', async () => {
    mocks.db.query
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [target()] });

    const result = await evaluateGraphitiValue(scope);

    expect(result).toMatchObject({
      graphitiFactCount: 0,
      relevantFactCount: 0,
      matchedStructuredCount: 0,
      precision: 0,
      recall: 0,
      precisionAt1: 0,
      recallAt1: 0,
      precisionAt3: 0,
      recallAt3: 0,
      mrr: 0,
      recommendation: 'shadow',
    });
  });

  it.each([
    ['Error', new Error('database unavailable'), 'database unavailable'],
    ['non-Error', 'database unavailable', 'database unavailable'],
  ])('fails back when canonical queries throw a %s value', async (_label, failure, message) => {
    mocks.db.query.mockRejectedValueOnce(failure);

    await expect(evaluateGraphitiValue(scope)).resolves.toMatchObject({
      graphitiReachable: false,
      recommendation: 'fallback',
      error: message,
    });
  });
});
