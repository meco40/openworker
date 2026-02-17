import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { SqliteKnowledgeRepository } from '../../../src/server/knowledge/sqliteKnowledgeRepository';
import type { UpsertKnowledgeEventInput } from '../../../src/server/knowledge/eventTypes';
import type { ExtractedEvent } from '../../../src/server/knowledge/eventExtractor';
import { deduplicateEvent } from '../../../src/server/knowledge/eventDedup';

const TEST_DB_DIR = '.local';
let dbPath: string;
let repo: SqliteKnowledgeRepository;

function makeInput(overrides: Partial<UpsertKnowledgeEventInput> = {}): UpsertKnowledgeEventInput {
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

function makeExtracted(overrides: Partial<ExtractedEvent> = {}): ExtractedEvent {
  return {
    eventType: 'shared_sleep',
    speakerRole: 'user',
    subject: 'Nata',
    counterpart: 'Max',
    relationLabel: 'Bruder',
    timeExpression: 'die letzten zwei Tage',
    startDate: '2026-02-15',
    endDate: '2026-02-16',
    dayCount: 2,
    isConfirmation: false,
    confirmationSignals: [],
    sourceSeq: [10, 11],
    ...overrides,
  };
}

beforeEach(() => {
  if (!existsSync(TEST_DB_DIR)) mkdirSync(TEST_DB_DIR, { recursive: true });
  dbPath = `${TEST_DB_DIR}/test-dedup-${Date.now()}.db`;
  repo = new SqliteKnowledgeRepository(dbPath);
});

afterEach(() => {
  try {
    if (existsSync(dbPath)) unlinkSync(dbPath);
  } catch {
    // ignore EBUSY on Windows
  }
});

describe('deduplicateEvent', () => {
  const scope = { userId: 'user-1', personaId: 'persona-nata' };

  it('returns "new" when no overlapping event exists', () => {
    const extracted = makeExtracted();
    const result = deduplicateEvent(extracted, scope, repo);

    expect(result.action).toBe('new');
    expect(result.mergedIntoId).toBeUndefined();
  });

  it('returns "merge" when overlapping event with same type and counterpart exists', () => {
    // Insert existing event for Feb 15-16
    const existing = makeInput();
    repo.upsertEvent(existing);

    // New extracted event overlaps (Feb 16-17) — same type, same counterpart
    const extracted = makeExtracted({
      startDate: '2026-02-16',
      endDate: '2026-02-17',
      dayCount: 2,
      sourceSeq: [15, 16],
    });

    const result = deduplicateEvent(extracted, scope, repo);

    expect(result.action).toBe('merge');
    expect(result.mergedIntoId).toBe(existing.id);
  });

  it('returns "new" when same type but different counterpart (no overlap match)', () => {
    // Existing event: Nata slept with Max
    repo.upsertEvent(makeInput());

    // New event: Nata slept with Tom — different counterpart
    const extracted = makeExtracted({
      counterpart: 'Tom',
      startDate: '2026-02-15',
      endDate: '2026-02-16',
    });

    const result = deduplicateEvent(extracted, scope, repo);

    expect(result.action).toBe('new');
  });

  it('returns "confirmation" when extracted event is a confirmation', () => {
    // Existing event
    repo.upsertEvent(makeInput());

    // Confirmation of same event
    const extracted = makeExtracted({
      isConfirmation: true,
      confirmationSignals: ['ja, genau'],
      startDate: '2026-02-15',
      endDate: '2026-02-16',
      sourceSeq: [20],
    });

    const result = deduplicateEvent(extracted, scope, repo);

    expect(result.action).toBe('confirmation');
    expect(result.mergedIntoId).toBe(undefined); // confirmation is stored separately
  });

  it('returns "new" when different eventType even with date overlap', () => {
    // Existing: shared_sleep Feb 15-16
    repo.upsertEvent(makeInput());

    // New: visit Feb 15-16 — different eventType
    const extracted = makeExtracted({
      eventType: 'visit',
      startDate: '2026-02-15',
      endDate: '2026-02-16',
    });

    const result = deduplicateEvent(extracted, scope, repo);

    expect(result.action).toBe('new');
  });

  it('returns "new" when different speakerRole even with overlap', () => {
    // Existing: user says Nata slept with Max (Feb 15-16)
    repo.upsertEvent(makeInput({ speakerRole: 'user' }));

    // New: assistant restates same event — different speakerRole
    const extracted = makeExtracted({
      speakerRole: 'assistant',
      startDate: '2026-02-15',
      endDate: '2026-02-16',
      sourceSeq: [12],
    });

    // Different speaker restating = confirmation, not a new parallel event
    // But dedup doesn't auto-detect restatement — that's the LLM's job
    // Here: dedup says "new" because findOverlappingEvents also checks speakerRole
    const result = deduplicateEvent(extracted, scope, repo);

    // The speakerRole filter means assistant events don't overlap user events
    expect(result.action).toBe('new');
  });

  it('merge appends source sequences to existing event', () => {
    const existing = makeInput({ sourceSeqJson: JSON.stringify([10, 11]) });
    repo.upsertEvent(existing);

    const extracted = makeExtracted({
      startDate: '2026-02-16',
      endDate: '2026-02-17',
      dayCount: 2,
      sourceSeq: [15, 16],
    });

    const result = deduplicateEvent(extracted, scope, repo);
    expect(result.action).toBe('merge');

    // Verify sources were appended
    const events = repo.listEvents({ userId: 'user-1', personaId: 'persona-nata' });
    const merged = events.find((e) => e.id === existing.id);
    expect(merged).toBeDefined();

    const seqs = JSON.parse(merged!.sourceSeqJson) as number[];
    expect(seqs).toContain(10);
    expect(seqs).toContain(11);
    expect(seqs).toContain(15);
    expect(seqs).toContain(16);
  });

  it('returns "new" when dates do not overlap at all', () => {
    // Existing: Feb 15-16
    repo.upsertEvent(makeInput());

    // New: Feb 20-21 (no overlap)
    const extracted = makeExtracted({
      startDate: '2026-02-20',
      endDate: '2026-02-21',
      sourceSeq: [30],
    });

    const result = deduplicateEvent(extracted, scope, repo);

    expect(result.action).toBe('new');
  });
});
