import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { SqliteKnowledgeRepository } from '@/server/knowledge/sqliteKnowledgeRepository';
import type { UpsertKnowledgeEventInput } from '@/server/knowledge/eventTypes';
import { computeEventAnswer, type EventAnswerScope } from '@/server/knowledge/eventAnswerComputer';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

const TEST_DB_DIR = getTestArtifactsRoot();
let dbPath: string;
let repo: SqliteKnowledgeRepository;

function makeEvent(overrides: Partial<UpsertKnowledgeEventInput> = {}): UpsertKnowledgeEventInput {
  return {
    id: `kevt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId: 'user-1',
    personaId: 'persona-nata',
    conversationId: 'conv-1',
    eventType: 'shared_sleep',
    speakerRole: 'user',
    speakerEntity: 'Mensch',
    subjectEntity: 'Nata',
    counterpartEntity: 'Max',
    relationLabel: 'Bruder',
    startDate: '2026-02-15',
    endDate: '2026-02-16',
    dayCount: 2,
    sourceSeqJson: JSON.stringify([10, 11]),
    sourceSummary: 'Nata hat mit Max geschlafen',
    isConfirmation: false,
    confidence: 0.9,
    ...overrides,
  };
}

beforeEach(() => {
  if (!existsSync(TEST_DB_DIR)) mkdirSync(TEST_DB_DIR, { recursive: true });
  dbPath = `${TEST_DB_DIR}/test-event-answer-${Date.now()}.db`;
  repo = new SqliteKnowledgeRepository(dbPath);
});

afterEach(() => {
  try {
    if (existsSync(dbPath)) unlinkSync(dbPath);
  } catch {
    // ignore
  }
});

describe('computeEventAnswer', () => {
  const scope: EventAnswerScope = {
    userId: 'user-1',
    personaId: 'persona-nata',
  };

  it('returns computed answer with correct day count — reference scenario', () => {
    // Week 1: Nata tells about sleeping 2 days with Max
    repo.upsertEvent(
      makeEvent({
        startDate: '2026-02-01',
        endDate: '2026-02-02',
        dayCount: 2,
      }),
    );

    // Week 3: Nata tells about sleeping 1 more day with Max
    repo.upsertEvent(
      makeEvent({
        id: `kevt-${Date.now()}-b`,
        startDate: '2026-02-15',
        endDate: '2026-02-15',
        dayCount: 1,
      }),
    );

    const result = computeEventAnswer(
      { eventType: 'shared_sleep', counterpartEntity: 'max' },
      scope,
      repo,
    );

    expect(result).not.toBeNull();
    expect(result).toContain('3');
    expect(result).toContain('Tage');
  });

  it('returns null when no events match', () => {
    const result = computeEventAnswer(
      { eventType: 'visit', counterpartEntity: 'tom' },
      scope,
      repo,
    );

    expect(result).toBeNull();
  });

  it('ignores confirmation events in day count', () => {
    // Real event: 2 days
    repo.upsertEvent(
      makeEvent({
        startDate: '2026-02-15',
        endDate: '2026-02-16',
        dayCount: 2,
      }),
    );

    // Confirmation: same date range
    repo.upsertEvent(
      makeEvent({
        id: `kevt-${Date.now()}-confirm`,
        startDate: '2026-02-16',
        endDate: '2026-02-17',
        dayCount: 1,
        isConfirmation: true,
      }),
    );

    const result = computeEventAnswer(
      { eventType: 'shared_sleep', counterpartEntity: 'max' },
      scope,
      repo,
    );

    expect(result).toContain('2');
    // Must NOT be 3 — confirmation should be ignored
    expect(result).not.toContain('3');
  });

  it('includes counterpart name in the answer', () => {
    repo.upsertEvent(makeEvent({ startDate: '2026-02-15', endDate: '2026-02-15', dayCount: 1 }));

    const result = computeEventAnswer(
      { eventType: 'shared_sleep', counterpartEntity: 'max' },
      scope,
      repo,
    );

    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('max');
  });
});
