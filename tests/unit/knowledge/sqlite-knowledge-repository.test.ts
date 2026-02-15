import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { getKnowledgeRepository } from '../../../src/server/knowledge/runtime';
import { SqliteKnowledgeRepository } from '../../../src/server/knowledge/sqliteKnowledgeRepository';

function uniqueDbPath(name: string): string {
  return path.join(
    process.cwd(),
    '.local',
    `${name}.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('SqliteKnowledgeRepository', () => {
  const createdDbFiles: string[] = [];
  const openRepositories: SqliteKnowledgeRepository[] = [];
  const originalKnowledgeDbPath = process.env.KNOWLEDGE_DB_PATH;

  const scope = {
    userId: 'user-a',
    personaId: 'persona-a',
  };

  afterEach(() => {
    for (const repo of openRepositories.splice(0, openRepositories.length)) {
      try {
        repo.close();
      } catch {
        // Ignore already-closed handles in cleanup.
      }
    }

    const runtimeCache = globalThis as { __knowledgeRepository?: SqliteKnowledgeRepository };
    if (runtimeCache.__knowledgeRepository) {
      try {
        runtimeCache.__knowledgeRepository.close();
      } catch {
        // Ignore already-closed singleton cleanup.
      }
      runtimeCache.__knowledgeRepository = undefined;
    }

    for (const dbFile of createdDbFiles.splice(0, createdDbFiles.length)) {
      if (!fs.existsSync(dbFile)) continue;
      try {
        fs.unlinkSync(dbFile);
      } catch {
        // Ignore transient Windows file lock delays.
      }
    }

    process.env.KNOWLEDGE_DB_PATH = originalKnowledgeDbPath;
  });

  it('creates required tables and indexes', () => {
    const dbPath = uniqueDbPath('knowledge.repository.schema');
    createdDbFiles.push(dbPath);
    const repo = new SqliteKnowledgeRepository(dbPath);
    openRepositories.push(repo);

    const db = new BetterSqlite3(dbPath, { readonly: true });
    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'knowledge_%'")
      .all() as Array<{ name: string }>;
    const indexRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_knowledge_%'")
      .all() as Array<{ name: string }>;
    db.close();

    const tableNames = tableRows.map((row) => row.name);
    expect(tableNames).toEqual(
      expect.arrayContaining([
        'knowledge_ingestion_checkpoints',
        'knowledge_episodes',
        'knowledge_meeting_ledger',
        'knowledge_retrieval_audit',
      ]),
    );

    const indexNames = indexRows.map((row) => row.name);
    expect(indexNames).toEqual(
      expect.arrayContaining([
        'idx_knowledge_checkpoints_scope_updated',
        'idx_knowledge_episodes_scope_updated',
        'idx_knowledge_episodes_topic_date',
        'idx_knowledge_meeting_scope_updated',
        'idx_knowledge_meeting_counterpart_date',
        'idx_knowledge_meeting_topic_date',
        'idx_knowledge_retrieval_audit_scope_updated',
      ]),
    );
  });

  it('supports CRUD for ingestion checkpoints', () => {
    const dbPath = uniqueDbPath('knowledge.repository.checkpoints');
    createdDbFiles.push(dbPath);
    const repo = new SqliteKnowledgeRepository(dbPath);
    openRepositories.push(repo);

    repo.upsertIngestionCheckpoint({
      userId: scope.userId,
      personaId: scope.personaId,
      conversationId: 'conv-1',
      lastProcessedSeq: 10,
      updatedAt: '2026-02-15T12:00:00.000Z',
    });

    const first = repo.getIngestionCheckpoint(scope.userId, scope.personaId, 'conv-1');
    expect(first).not.toBeNull();
    expect(first?.lastProcessedSeq).toBe(10);

    repo.upsertIngestionCheckpoint({
      userId: scope.userId,
      personaId: scope.personaId,
      conversationId: 'conv-1',
      lastProcessedSeq: 42,
      updatedAt: '2026-02-15T13:00:00.000Z',
    });

    const updated = repo.getIngestionCheckpoint(scope.userId, scope.personaId, 'conv-1');
    expect(updated?.lastProcessedSeq).toBe(42);
    expect(updated?.updatedAt).toBe('2026-02-15T13:00:00.000Z');

    expect(repo.deleteIngestionCheckpoint(scope.userId, scope.personaId, 'conv-1')).toBe(1);
    expect(repo.getIngestionCheckpoint(scope.userId, scope.personaId, 'conv-1')).toBeNull();
  });

  it('supports CRUD for knowledge episodes', () => {
    const dbPath = uniqueDbPath('knowledge.repository.episodes');
    createdDbFiles.push(dbPath);
    const repo = new SqliteKnowledgeRepository(dbPath);
    openRepositories.push(repo);

    repo.insertEpisode({
      id: 'episode-1',
      userId: scope.userId,
      personaId: scope.personaId,
      topicKey: 'negotiation',
      counterpart: 'andreas',
      date: '2026-02-14',
      teaser: 'We negotiated priorities.',
      summary: 'Detailed recap of the negotiation and open points.',
      sourceRefs: ['msg:100', 'msg:105'],
      updatedAt: '2026-02-15T12:00:00.000Z',
    });

    const inserted = repo.getEpisode(scope.userId, scope.personaId, 'episode-1');
    expect(inserted).not.toBeNull();
    expect(inserted?.sourceRefs).toEqual(['msg:100', 'msg:105']);

    const updatedRows = repo.updateEpisode({
      id: 'episode-1',
      userId: scope.userId,
      personaId: scope.personaId,
      topicKey: 'commercial-negotiation',
      counterpart: 'andreas',
      date: '2026-02-15',
      teaser: 'Updated teaser',
      summary: 'Updated summary',
      sourceRefs: ['msg:111'],
      updatedAt: '2026-02-15T12:30:00.000Z',
    });
    expect(updatedRows).toBe(1);

    const updated = repo.getEpisode(scope.userId, scope.personaId, 'episode-1');
    expect(updated?.topicKey).toBe('commercial-negotiation');
    expect(updated?.summary).toBe('Updated summary');
    expect(updated?.sourceRefs).toEqual(['msg:111']);

    expect(repo.deleteEpisode(scope.userId, scope.personaId, 'episode-1')).toBe(1);
    expect(repo.getEpisode(scope.userId, scope.personaId, 'episode-1')).toBeNull();
  });

  it('supports CRUD for meeting ledger rows', () => {
    const dbPath = uniqueDbPath('knowledge.repository.ledger');
    createdDbFiles.push(dbPath);
    const repo = new SqliteKnowledgeRepository(dbPath);
    openRepositories.push(repo);

    repo.insertMeetingLedgerEntry({
      id: 'meeting-1',
      userId: scope.userId,
      personaId: scope.personaId,
      counterpart: 'andreas',
      topicKey: 'q1-planning',
      date: '2026-02-12',
      decisions: ['Ship phase one'],
      negotiatedTerms: ['Cap budget at 30k'],
      openPoints: ['Finalize rollout date'],
      actionItems: ['Prepare revised milestone list'],
      sourceRefs: ['msg:200'],
      updatedAt: '2026-02-15T10:00:00.000Z',
    });

    const inserted = repo.getMeetingLedgerEntry(scope.userId, scope.personaId, 'meeting-1');
    expect(inserted).not.toBeNull();
    expect(inserted?.decisions).toEqual(['Ship phase one']);

    const updatedRows = repo.updateMeetingLedgerEntry({
      id: 'meeting-1',
      userId: scope.userId,
      personaId: scope.personaId,
      counterpart: 'andreas',
      topicKey: 'q1-planning',
      date: '2026-02-13',
      decisions: ['Ship phase one', 'Review timeline weekly'],
      negotiatedTerms: ['Cap budget at 32k'],
      openPoints: ['Finalize rollout date'],
      actionItems: ['Prepare revised milestone list', 'Send draft contract'],
      sourceRefs: ['msg:200', 'msg:201'],
      updatedAt: '2026-02-15T11:00:00.000Z',
    });
    expect(updatedRows).toBe(1);

    const updated = repo.getMeetingLedgerEntry(scope.userId, scope.personaId, 'meeting-1');
    expect(updated?.date).toBe('2026-02-13');
    expect(updated?.negotiatedTerms).toEqual(['Cap budget at 32k']);
    expect(updated?.sourceRefs).toEqual(['msg:200', 'msg:201']);

    expect(repo.deleteMeetingLedgerEntry(scope.userId, scope.personaId, 'meeting-1')).toBe(1);
    expect(repo.getMeetingLedgerEntry(scope.userId, scope.personaId, 'meeting-1')).toBeNull();
  });

  it('supports CRUD for retrieval audit rows', () => {
    const dbPath = uniqueDbPath('knowledge.repository.audit');
    createdDbFiles.push(dbPath);
    const repo = new SqliteKnowledgeRepository(dbPath);
    openRepositories.push(repo);

    repo.insertRetrievalAudit({
      id: 'audit-1',
      userId: scope.userId,
      personaId: scope.personaId,
      queryText: 'How did the Andreas meeting end?',
      counterpart: 'andreas',
      topicKey: 'q1-planning',
      date: '2026-02-13',
      resultIds: ['meeting-1', 'episode-4'],
      updatedAt: '2026-02-15T12:00:00.000Z',
    });

    const inserted = repo.getRetrievalAudit(scope.userId, scope.personaId, 'audit-1');
    expect(inserted).not.toBeNull();
    expect(inserted?.resultIds).toEqual(['meeting-1', 'episode-4']);

    const updatedRows = repo.updateRetrievalAudit({
      id: 'audit-1',
      userId: scope.userId,
      personaId: scope.personaId,
      queryText: 'What did we agree with Andreas?',
      counterpart: 'andreas',
      topicKey: 'q1-planning',
      date: '2026-02-13',
      resultIds: ['meeting-1'],
      updatedAt: '2026-02-15T12:30:00.000Z',
    });
    expect(updatedRows).toBe(1);

    const updated = repo.getRetrievalAudit(scope.userId, scope.personaId, 'audit-1');
    expect(updated?.queryText).toBe('What did we agree with Andreas?');
    expect(updated?.resultIds).toEqual(['meeting-1']);

    expect(repo.deleteRetrievalAudit(scope.userId, scope.personaId, 'audit-1')).toBe(1);
    expect(repo.getRetrievalAudit(scope.userId, scope.personaId, 'audit-1')).toBeNull();
  });

  it('runs migrations idempotently across repeated initializations', () => {
    const dbPath = uniqueDbPath('knowledge.repository.idempotent');
    createdDbFiles.push(dbPath);

    const first = new SqliteKnowledgeRepository(dbPath);
    first.insertEpisode({
      id: 'episode-persist',
      userId: scope.userId,
      personaId: scope.personaId,
      topicKey: 'retrospective',
      counterpart: 'team',
      date: '2026-02-10',
      teaser: 'Retro teaser',
      summary: 'Retro summary',
      sourceRefs: ['msg:300'],
      updatedAt: '2026-02-15T09:00:00.000Z',
    });
    first.close();

    const second = new SqliteKnowledgeRepository(dbPath);
    openRepositories.push(second);
    const secondRead = second.getEpisode(scope.userId, scope.personaId, 'episode-persist');
    expect(secondRead?.id).toBe('episode-persist');

    second.close();
    openRepositories.pop();

    const third = new SqliteKnowledgeRepository(dbPath);
    openRepositories.push(third);
    const thirdRead = third.getEpisode(scope.userId, scope.personaId, 'episode-persist');
    expect(thirdRead?.summary).toBe('Retro summary');
  });

  it('recreates runtime singleton after close', () => {
    const dbPath = uniqueDbPath('knowledge.repository.runtime-reopen');
    createdDbFiles.push(dbPath);
    process.env.KNOWLEDGE_DB_PATH = dbPath;

    const first = getKnowledgeRepository();
    first.close();

    const second = getKnowledgeRepository();
    expect(second).not.toBe(first);
    second.insertEpisode({
      id: 'runtime-episode',
      userId: scope.userId,
      personaId: scope.personaId,
      topicKey: 'runtime',
      counterpart: 'system',
      date: '2026-02-15',
      teaser: 'runtime teaser',
      summary: 'runtime summary',
      sourceRefs: ['msg:runtime'],
      updatedAt: '2026-02-15T14:00:00.000Z',
    });

    const row = second.getEpisode(scope.userId, scope.personaId, 'runtime-episode');
    expect(row?.summary).toBe('runtime summary');
    openRepositories.push(second);
  });

  it('falls back to empty arrays when stored JSON columns are malformed', () => {
    const dbPath = uniqueDbPath('knowledge.repository.json-fallback');
    createdDbFiles.push(dbPath);

    const first = new SqliteKnowledgeRepository(dbPath);
    first.insertEpisode({
      id: 'episode-json',
      userId: scope.userId,
      personaId: scope.personaId,
      topicKey: 'topic',
      counterpart: 'andreas',
      date: '2026-02-15',
      teaser: 'teaser',
      summary: 'summary',
      sourceRefs: ['msg:1'],
      updatedAt: '2026-02-15T15:00:00.000Z',
    });
    first.insertMeetingLedgerEntry({
      id: 'meeting-json',
      userId: scope.userId,
      personaId: scope.personaId,
      counterpart: 'andreas',
      topicKey: 'topic',
      date: '2026-02-15',
      decisions: ['d1'],
      negotiatedTerms: ['n1'],
      openPoints: ['o1'],
      actionItems: ['a1'],
      sourceRefs: ['msg:2'],
      updatedAt: '2026-02-15T15:00:00.000Z',
    });
    first.insertRetrievalAudit({
      id: 'audit-json',
      userId: scope.userId,
      personaId: scope.personaId,
      queryText: 'query',
      counterpart: 'andreas',
      topicKey: 'topic',
      date: '2026-02-15',
      resultIds: ['episode-json'],
      updatedAt: '2026-02-15T15:00:00.000Z',
    });
    first.close();

    const db = new BetterSqlite3(dbPath);
    db.prepare("UPDATE knowledge_episodes SET source_refs_json = 'not-json' WHERE id = ?")
      .run('episode-json');
    db.prepare(
      "UPDATE knowledge_meeting_ledger SET decisions_json = 'not-json', negotiated_terms_json = 'not-json', open_points_json = 'not-json', action_items_json = 'not-json', source_refs_json = 'not-json' WHERE id = ?",
    ).run('meeting-json');
    db.prepare("UPDATE knowledge_retrieval_audit SET result_ids_json = 'not-json' WHERE id = ?")
      .run('audit-json');
    db.close();

    const second = new SqliteKnowledgeRepository(dbPath);
    openRepositories.push(second);

    expect(() => second.getEpisode(scope.userId, scope.personaId, 'episode-json')).not.toThrow();
    expect(second.getEpisode(scope.userId, scope.personaId, 'episode-json')?.sourceRefs).toEqual(
      [],
    );

    const meeting = second.getMeetingLedgerEntry(scope.userId, scope.personaId, 'meeting-json');
    expect(meeting?.decisions).toEqual([]);
    expect(meeting?.negotiatedTerms).toEqual([]);
    expect(meeting?.openPoints).toEqual([]);
    expect(meeting?.actionItems).toEqual([]);
    expect(meeting?.sourceRefs).toEqual([]);

    expect(second.getRetrievalAudit(scope.userId, scope.personaId, 'audit-json')?.resultIds).toEqual(
      [],
    );
  });
});
