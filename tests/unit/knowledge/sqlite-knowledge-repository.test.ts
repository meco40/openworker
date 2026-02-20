import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SqliteKnowledgeRepository } from '@/server/knowledge/sqliteKnowledgeRepository';

function createDbPath(): string {
  return path.join(
    process.cwd(),
    '.local',
    `knowledge.repo.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('SqliteKnowledgeRepository', () => {
  let dbPath = '';

  beforeEach(() => {
    dbPath = createDbPath();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('creates schema and supports idempotent migrations', () => {
    const first = new SqliteKnowledgeRepository(dbPath);
    const second = new SqliteKnowledgeRepository(dbPath);

    expect(first.getIngestionCheckpoint('conv-1', 'persona-1')).toBeNull();
    expect(second.getIngestionCheckpoint('conv-1', 'persona-1')).toBeNull();
  });

  it('persists ingestion checkpoint atomically', () => {
    const repo = new SqliteKnowledgeRepository(dbPath);

    repo.upsertIngestionCheckpoint({
      conversationId: 'conv-1',
      personaId: 'persona-1',
      lastSeq: 11,
    });

    const checkpoint = repo.getIngestionCheckpoint('conv-1', 'persona-1');
    expect(checkpoint?.lastSeq).toBe(11);

    repo.upsertIngestionCheckpoint({
      conversationId: 'conv-1',
      personaId: 'persona-1',
      lastSeq: 22,
    });

    const updated = repo.getIngestionCheckpoint('conv-1', 'persona-1');
    expect(updated?.lastSeq).toBe(22);
  });

  it('stores and queries episode and meeting ledger records', () => {
    const repo = new SqliteKnowledgeRepository(dbPath);

    const episode = repo.upsertEpisode({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-1',
      topicKey: 'meeting-andreas',
      counterpart: 'Andreas',
      teaser: 'Kurzer Teaser mit den wichtigsten Eckpunkten.',
      episode: 'Langer Episodentext '.repeat(60),
      facts: ['Wir haben Preise verhandelt', 'Lieferfenster wurde fixiert'],
      sourceSeqStart: 10,
      sourceSeqEnd: 25,
      sourceRefs: [{ seq: 12, quote: 'Wir landen bei 8% Rabatt' }],
      eventAt: '2025-08-11T09:00:00.000Z',
    });

    const ledger = repo.upsertMeetingLedger({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-1',
      topicKey: 'meeting-andreas',
      counterpart: 'Andreas',
      eventAt: '2025-08-11T09:00:00.000Z',
      participants: ['Ich', 'Andreas'],
      decisions: ['Pilot startet im September'],
      negotiatedTerms: ['8% Rabatt bei 12 Monaten Laufzeit'],
      openPoints: ['Finale SLA-Freigabe'],
      actionItems: ['Andreas sendet Vertragsentwurf bis Freitag'],
      sourceRefs: [{ seq: 17, quote: 'Wir können 8% anbieten.' }],
      confidence: 0.86,
    });

    expect(episode.id).toBeTruthy();
    expect(ledger.id).toBeTruthy();

    const episodes = repo.listEpisodes({
      userId: 'user-1',
      personaId: 'persona-1',
      counterpart: 'andreas',
    });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].topicKey).toBe('meeting-andreas');

    const ledgerRows = repo.listMeetingLedger({
      userId: 'user-1',
      personaId: 'persona-1',
      counterpart: 'andreas',
    });
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].decisions[0]).toContain('Pilot');
  });

  it('stores retrieval audit rows and exposes counts', () => {
    const repo = new SqliteKnowledgeRepository(dbPath);

    repo.insertRetrievalAudit({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-1',
      query: 'Was haben wir ausgehandelt?',
      stageStats: { ledger: 1, episodes: 1, evidence: 2 },
      tokenCount: 410,
      hadError: false,
    });

    const rows = repo.listRetrievalAudit({ userId: 'user-1', personaId: 'persona-1' });
    expect(rows).toHaveLength(1);
    expect(rows[0].stageStats.ledger).toBe(1);

    const stats = repo.getKnowledgeStats('user-1', 'persona-1');
    expect(stats.episodeCount).toBe(0);
    expect(stats.ledgerCount).toBe(0);
    expect(stats.retrievalErrorCount).toBe(0);
  });

  it('stores and retrieves conversation summaries', () => {
    const repo = new SqliteKnowledgeRepository(dbPath);

    const summary = repo.upsertConversationSummary({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-1',
      summaryText: 'Wir haben ueber Projekt Alpha gesprochen und Meilensteine definiert.',
      keyTopics: ['Projekt Alpha', 'Meilensteine'],
      entitiesMentioned: ['Max', 'Lisa'],
      emotionalTone: 'sachlich',
      messageCount: 12,
      timeRangeStart: '2026-02-15T09:00:00.000Z',
      timeRangeEnd: '2026-02-15T10:30:00.000Z',
    });

    expect(summary.id).toBeTruthy();
    expect(summary.summaryText).toContain('Projekt Alpha');

    const summaries = repo.listConversationSummaries({
      userId: 'user-1',
      personaId: 'persona-1',
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].keyTopics).toContain('Projekt Alpha');
    expect(summaries[0].entitiesMentioned).toContain('Max');
    expect(summaries[0].messageCount).toBe(12);
  });

  it('upserts conversation summary on same conversationId+personaId', () => {
    const repo = new SqliteKnowledgeRepository(dbPath);

    repo.upsertConversationSummary({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-1',
      summaryText: 'Erste Zusammenfassung',
      keyTopics: ['Thema A'],
      entitiesMentioned: [],
      emotionalTone: null,
      messageCount: 5,
      timeRangeStart: '2026-02-15T09:00:00.000Z',
      timeRangeEnd: '2026-02-15T09:30:00.000Z',
    });

    repo.upsertConversationSummary({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-1',
      summaryText: 'Aktualisierte Zusammenfassung',
      keyTopics: ['Thema A', 'Thema B'],
      entitiesMentioned: ['Max'],
      emotionalTone: 'freundlich',
      messageCount: 10,
      timeRangeStart: '2026-02-15T09:00:00.000Z',
      timeRangeEnd: '2026-02-15T10:30:00.000Z',
    });

    const summaries = repo.listConversationSummaries({
      userId: 'user-1',
      personaId: 'persona-1',
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].summaryText).toBe('Aktualisierte Zusammenfassung');
    expect(summaries[0].messageCount).toBe(10);
  });
});
