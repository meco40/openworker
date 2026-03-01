import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SqliteKnowledgeRepository } from '@/server/knowledge/sqliteKnowledgeRepository';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function createDbPath(): string {
  return path.join(
    getTestArtifactsRoot(),
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

  it('supports in-memory database path and idempotent close', () => {
    const repo = new SqliteKnowledgeRepository(':memory:');
    expect(repo.getIngestionCheckpoint('conv-memory', 'persona-memory')).toBeNull();
    expect(() => repo.close()).not.toThrow();
    expect(() => repo.close()).not.toThrow();
  });

  it('counts retrieval errors and exposes latest ingestion lag', () => {
    const repo = new SqliteKnowledgeRepository(dbPath);
    repo.upsertIngestionCheckpoint({
      conversationId: 'conv-1',
      personaId: 'persona-1',
      lastSeq: 3,
    });
    repo.insertRetrievalAudit({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-1',
      query: 'Fehlerhafte Abfrage',
      stageStats: {},
      tokenCount: 10,
      hadError: true,
      errorMessage: 'boom',
    });

    const stats = repo.getKnowledgeStats('user-1', 'persona-1');
    expect(stats.retrievalErrorCount).toBe(1);
    expect(stats.latestIngestionAt).toBeTruthy();
    expect(stats.ingestionLagMs).toBeGreaterThanOrEqual(0);
  });

  it('prunes by cutoff with dry-run and delete modes', () => {
    const repo = new SqliteKnowledgeRepository(dbPath);
    repo.upsertEpisode({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-prune-ep',
      topicKey: 'topic-prune',
      counterpart: null,
      teaser: 'teaser',
      episode: 'episode',
      facts: ['fact'],
      sourceSeqStart: 1,
      sourceSeqEnd: 1,
      sourceRefs: [],
      eventAt: '2025-01-01T00:00:00.000Z',
    });
    repo.upsertMeetingLedger({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-prune-ledger',
      topicKey: 'topic-prune',
      counterpart: null,
      eventAt: '2025-01-01T00:00:00.000Z',
      participants: [],
      decisions: [],
      negotiatedTerms: [],
      openPoints: [],
      actionItems: [],
      sourceRefs: [],
      confidence: 0.5,
    });
    repo.insertRetrievalAudit({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-prune-audit',
      query: 'q',
      stageStats: {},
      tokenCount: 1,
      hadError: false,
    });

    expect(
      repo.pruneKnowledgeBefore({
        userId: 'user-1',
        personaId: 'persona-1',
        beforeIso: 'not-a-date',
      }),
    ).toEqual({ episodes: 0, ledger: 0, audits: 0 });

    const dryRun = repo.pruneKnowledgeBefore({
      userId: 'user-1',
      personaId: 'persona-1',
      beforeIso: '2099-01-01T00:00:00.000Z',
      dryRun: true,
    });
    expect(dryRun.episodes).toBeGreaterThanOrEqual(1);
    expect(dryRun.ledger).toBeGreaterThanOrEqual(1);
    expect(dryRun.audits).toBeGreaterThanOrEqual(1);

    const beforeDeleteStats = repo.getKnowledgeStats('user-1', 'persona-1');
    expect(beforeDeleteStats.retrievalErrorCount).toBe(0);

    const deleted = repo.pruneKnowledgeBefore({
      userId: 'user-1',
      personaId: 'persona-1',
      beforeIso: '2099-01-01T00:00:00.000Z',
    });
    expect(deleted).toEqual(dryRun);
    expect(repo.listEpisodes({ userId: 'user-1', personaId: 'persona-1' })).toHaveLength(0);
    expect(repo.listMeetingLedger({ userId: 'user-1', personaId: 'persona-1' })).toHaveLength(0);
    expect(repo.listRetrievalAudit({ userId: 'user-1', personaId: 'persona-1' })).toHaveLength(0);
  });

  it('deletes all scoped knowledge artifacts in one transaction', () => {
    const repo = new SqliteKnowledgeRepository(dbPath);
    repo.upsertIngestionCheckpoint({
      conversationId: 'conv-delete-checkpoint',
      personaId: 'persona-1',
      lastSeq: 1,
    });
    repo.upsertEpisode({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-delete-ep',
      topicKey: 'topic-delete',
      counterpart: null,
      teaser: 'teaser',
      episode: 'episode',
      facts: ['fact'],
      sourceSeqStart: 1,
      sourceSeqEnd: 1,
      sourceRefs: [],
      eventAt: null,
    });
    repo.upsertMeetingLedger({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-delete-ledger',
      topicKey: 'topic-delete',
      counterpart: null,
      eventAt: null,
      participants: [],
      decisions: [],
      negotiatedTerms: [],
      openPoints: [],
      actionItems: [],
      sourceRefs: [],
      confidence: 0.8,
    });
    repo.insertRetrievalAudit({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-delete-audit',
      query: 'q',
      stageStats: {},
      tokenCount: 1,
      hadError: false,
    });
    repo.upsertConversationSummary({
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-delete-summary',
      summaryText: 'summary',
      keyTopics: ['topic-delete'],
      entitiesMentioned: ['Max'],
      emotionalTone: null,
      messageCount: 2,
      timeRangeStart: '2026-02-15T09:00:00.000Z',
      timeRangeEnd: '2026-02-15T09:10:00.000Z',
    });
    repo.upsertEvent({
      id: 'evt-delete-1',
      userId: 'user-1',
      personaId: 'persona-1',
      conversationId: 'conv-delete-event',
      eventType: 'shared_sleep',
      speakerRole: 'assistant',
      speakerEntity: 'Nata',
      subjectEntity: 'Nata',
      counterpartEntity: 'Max',
      relationLabel: 'Bruder',
      startDate: '2026-02-15',
      endDate: '2026-02-16',
      dayCount: 2,
      sourceSeqJson: '[1]',
      sourceSummary: 'summary',
      isConfirmation: false,
      confidence: 0.9,
    });
    repo.upsertEntity({
      id: 'ent-delete-1',
      userId: 'user-1',
      personaId: 'persona-1',
      canonicalName: 'Max',
      category: 'person',
      owner: 'persona',
      properties: {},
    });

    const removed = repo.deleteKnowledgeByScope('user-1', 'persona-1');
    expect(removed).toBeGreaterThanOrEqual(7);
    expect(repo.getIngestionCheckpoint('conv-delete-checkpoint', 'persona-1')).toBeNull();
    expect(repo.listEpisodes({ userId: 'user-1', personaId: 'persona-1' })).toHaveLength(0);
    expect(repo.listMeetingLedger({ userId: 'user-1', personaId: 'persona-1' })).toHaveLength(0);
    expect(repo.listRetrievalAudit({ userId: 'user-1', personaId: 'persona-1' })).toHaveLength(0);
    expect(
      repo.listConversationSummaries({ userId: 'user-1', personaId: 'persona-1' }),
    ).toHaveLength(0);
    expect(repo.listEvents({ userId: 'user-1', personaId: 'persona-1' })).toHaveLength(0);
    expect(repo.listEntities({ userId: 'user-1', personaId: 'persona-1' })).toHaveLength(0);
  });
});
