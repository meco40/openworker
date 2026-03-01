import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteKnowledgeRepository } from '@/server/knowledge/sqliteKnowledgeRepository';
import type { UpsertKnowledgeEventInput } from '@/server/knowledge/eventTypes';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function createDbPath(): string {
  return path.join(
    getTestArtifactsRoot(),
    `knowledge-events.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

function makeEvent(overrides: Partial<UpsertKnowledgeEventInput> = {}): UpsertKnowledgeEventInput {
  return {
    id: `kevt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    userId: 'user-1',
    personaId: 'persona-nata',
    conversationId: 'conv-1',
    eventType: 'shared_sleep',
    speakerRole: 'assistant',
    speakerEntity: 'Nata',
    subjectEntity: 'Nata',
    counterpartEntity: 'Max',
    relationLabel: 'Bruder',
    startDate: '2026-02-15',
    endDate: '2026-02-16',
    dayCount: 2,
    sourceSeqJson: JSON.stringify([10]),
    sourceSummary: 'Nata hat mit Max geschlafen, die letzten 2 Tage',
    isConfirmation: false,
    confidence: 0.9,
    ...overrides,
  };
}

describe('SqliteKnowledgeRepository — Events', () => {
  let dbPath: string;
  let repo: SqliteKnowledgeRepository;

  beforeEach(() => {
    dbPath = createDbPath();
    repo = new SqliteKnowledgeRepository(dbPath);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
      if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
    } catch {
      // ignore cleanup errors
    }
  });

  it('upsertEvent stores and reads an event correctly', () => {
    const input = makeEvent();
    repo.upsertEvent(input);

    const events = repo.listEvents({
      userId: 'user-1',
      personaId: 'persona-nata',
    });

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('shared_sleep');
    expect(events[0].speakerRole).toBe('assistant');
    expect(events[0].speakerEntity).toBe('Nata');
    expect(events[0].counterpartEntity).toBe('Max');
    expect(events[0].startDate).toBe('2026-02-15');
    expect(events[0].endDate).toBe('2026-02-16');
    expect(events[0].dayCount).toBe(2);
    expect(events[0].isConfirmation).toBe(false);
    expect(events[0].confidence).toBe(0.9);
    expect(events[0].createdAt).toBeTruthy();
    expect(events[0].updatedAt).toBeTruthy();
  });

  it('countUniqueDays computes correct day count across non-overlapping events', () => {
    // Event A: Feb 15-16 (2 days)
    repo.upsertEvent(
      makeEvent({
        id: 'kevt-a',
        startDate: '2026-02-15',
        endDate: '2026-02-16',
        dayCount: 2,
      }),
    );

    // Event B: Feb 23 (1 day) — one week later
    repo.upsertEvent(
      makeEvent({
        id: 'kevt-b',
        startDate: '2026-02-23',
        endDate: '2026-02-23',
        dayCount: 1,
        sourceSeqJson: JSON.stringify([30]),
        sourceSummary: 'Nata hat gestern wieder mit Max geschlafen',
      }),
    );

    const result = repo.countUniqueDays({
      userId: 'user-1',
      personaId: 'persona-nata',
      eventType: 'shared_sleep',
      speakerRole: 'assistant',
    });

    expect(result.uniqueDayCount).toBe(3);
    expect(result.uniqueDays).toEqual(['2026-02-15', '2026-02-16', '2026-02-23']);
    expect(result.eventCount).toBe(2);
  });

  it('countUniqueDays ignores confirmation events', () => {
    // Real event: 2 days
    repo.upsertEvent(
      makeEvent({
        id: 'kevt-real',
        startDate: '2026-02-15',
        endDate: '2026-02-16',
        dayCount: 2,
      }),
    );

    // Confirmation stored as separate row (slightly different date range to avoid UNIQUE clash)
    // In production, dedup merges via appendEventSources — but if a confirmation
    // somehow gets stored as its own row, countUniqueDays must still ignore it.
    repo.upsertEvent(
      makeEvent({
        id: 'kevt-confirm',
        startDate: '2026-02-16',
        endDate: '2026-02-17',
        dayCount: 2,
        isConfirmation: true,
        sourceSeqJson: JSON.stringify([11]),
        sourceSummary: 'Ja, es ist richtig, es war die letzten zwei Tage',
      }),
    );

    const result = repo.countUniqueDays({
      userId: 'user-1',
      personaId: 'persona-nata',
      eventType: 'shared_sleep',
    });

    // Should be 2 (only from real event), not 4
    expect(result.uniqueDayCount).toBe(2);
    expect(result.eventCount).toBe(1); // Only real events counted
  });

  it('findOverlappingEvents detects date overlap', () => {
    repo.upsertEvent(
      makeEvent({
        id: 'kevt-existing',
        startDate: '2026-02-15',
        endDate: '2026-02-16',
      }),
    );

    const overlapping = repo.findOverlappingEvents({
      userId: 'user-1',
      personaId: 'persona-nata',
      eventType: 'shared_sleep',
      counterpartEntity: 'Max',
      from: '2026-02-14',
      to: '2026-02-15',
    });

    expect(overlapping).toHaveLength(1);
    expect(overlapping[0].id).toBe('kevt-existing');
  });

  it('findOverlappingEvents returns empty for non-overlapping dates', () => {
    repo.upsertEvent(
      makeEvent({
        id: 'kevt-existing',
        startDate: '2026-02-15',
        endDate: '2026-02-16',
      }),
    );

    const overlapping = repo.findOverlappingEvents({
      userId: 'user-1',
      personaId: 'persona-nata',
      eventType: 'shared_sleep',
      counterpartEntity: 'Max',
      from: '2026-02-20',
      to: '2026-02-22',
    });

    expect(overlapping).toHaveLength(0);
  });

  it('appendEventSources extends source_seq_json', () => {
    const input = makeEvent({ id: 'kevt-extend', sourceSeqJson: JSON.stringify([10]) });
    repo.upsertEvent(input);

    repo.appendEventSources('kevt-extend', [11, 12], 'Bestaetigung: Ja, es ist richtig');

    const events = repo.listEvents({ userId: 'user-1', personaId: 'persona-nata' });
    expect(events).toHaveLength(1);

    const seqs = JSON.parse(events[0].sourceSeqJson) as number[];
    expect(seqs).toContain(10);
    expect(seqs).toContain(11);
    expect(seqs).toContain(12);
    expect(events[0].sourceSummary).toContain('Bestaetigung');
  });

  it('speakerRole filter returns only matching events', () => {
    // Assistant event
    repo.upsertEvent(
      makeEvent({
        id: 'kevt-assistant',
        speakerRole: 'assistant',
        speakerEntity: 'Nata',
      }),
    );

    // User event — different person's experience
    repo.upsertEvent(
      makeEvent({
        id: 'kevt-user',
        speakerRole: 'user',
        speakerEntity: 'User',
        subjectEntity: 'User',
        counterpartEntity: 'Bruder-des-Users',
        startDate: '2026-03-01',
        endDate: '2026-03-01',
        dayCount: 1,
      }),
    );

    const assistantOnly = repo.listEvents({
      userId: 'user-1',
      personaId: 'persona-nata',
      speakerRole: 'assistant',
    });

    expect(assistantOnly).toHaveLength(1);
    expect(assistantOnly[0].speakerRole).toBe('assistant');

    const userOnly = repo.listEvents({
      userId: 'user-1',
      personaId: 'persona-nata',
      speakerRole: 'user',
    });

    expect(userOnly).toHaveLength(1);
    expect(userOnly[0].speakerRole).toBe('user');
  });

  it('UNIQUE constraint prevents exact duplicate events', () => {
    const input = makeEvent({ id: 'kevt-first' });
    repo.upsertEvent(input);

    // Same scope, same event type, same entities, same dates — should upsert, not error
    const duplicate = makeEvent({ id: 'kevt-second', sourceSummary: 'updated summary' });
    repo.upsertEvent(duplicate);

    const events = repo.listEvents({ userId: 'user-1', personaId: 'persona-nata' });
    // Should be 1 (upsert replaced it), not 2
    expect(events).toHaveLength(1);
    expect(events[0].sourceSummary).toBe('updated summary');
  });

  it('listEvents with eventType filter', () => {
    repo.upsertEvent(makeEvent({ id: 'kevt-sleep', eventType: 'shared_sleep' }));
    repo.upsertEvent(
      makeEvent({
        id: 'kevt-visit',
        eventType: 'visit',
        startDate: '2026-03-01',
        endDate: '2026-03-01',
        dayCount: 1,
      }),
    );

    const sleepEvents = repo.listEvents({
      userId: 'user-1',
      personaId: 'persona-nata',
      eventType: 'shared_sleep',
    });

    expect(sleepEvents).toHaveLength(1);
    expect(sleepEvents[0].eventType).toBe('shared_sleep');
  });
});
