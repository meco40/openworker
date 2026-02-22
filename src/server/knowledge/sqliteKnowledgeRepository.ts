import type BetterSqlite3 from 'better-sqlite3';
import type {
  KnowledgeRepository,
  KnowledgeStats,
  ListKnowledgeFilter,
} from '@/server/knowledge/repository';
import type {
  KnowledgeEventFilter,
  UpsertKnowledgeEventInput,
} from '@/server/knowledge/eventTypes';
import type { EntityGraphFilter } from '@/server/knowledge/entityGraph';
import { openSqliteDatabase } from '@/server/db/sqlite';
import { parseIso } from './repositories/utils';
import {
  CheckpointRepository,
  EpisodeRepository,
  LedgerRepository,
  AuditRepository,
  EventRepository,
  EntityRepository,
  SummaryRepository,
  runKnowledgeMigrations,
} from './repositories';

export class SqliteKnowledgeRepository implements KnowledgeRepository {
  private readonly db: BetterSqlite3.Database;
  private readonly checkpointRepo: CheckpointRepository;
  private readonly episodeRepo: EpisodeRepository;
  private readonly ledgerRepo: LedgerRepository;
  private readonly auditRepo: AuditRepository;
  private readonly eventRepo: EventRepository;
  private readonly entityRepo: EntityRepository;
  private readonly summaryRepo: SummaryRepository;

  constructor(
    dbPath = process.env.KNOWLEDGE_DB_PATH || process.env.MESSAGES_DB_PATH || '.local/messages.db',
  ) {
    this.db = openSqliteDatabase({ dbPath });

    runKnowledgeMigrations(this.db);

    // Initialize sub-repositories
    this.checkpointRepo = new CheckpointRepository(this.db);
    this.episodeRepo = new EpisodeRepository(this.db);
    this.ledgerRepo = new LedgerRepository(this.db);
    this.auditRepo = new AuditRepository(this.db);
    this.eventRepo = new EventRepository(this.db);
    this.entityRepo = new EntityRepository(this.db);
    this.summaryRepo = new SummaryRepository(this.db);
  }

  close(): void {
    if (this.db.open) {
      this.db.close();
    }
  }

  // ════════════════════════════════════════════════════════════
  // Checkpoint Operations
  // ════════════════════════════════════════════════════════════

  getIngestionCheckpoint(conversationId: string, personaId: string) {
    return this.checkpointRepo.getIngestionCheckpoint(conversationId, personaId);
  }

  upsertIngestionCheckpoint(
    input: import('@/server/knowledge/repository').UpsertKnowledgeCheckpointInput,
  ) {
    return this.checkpointRepo.upsertIngestionCheckpoint(input);
  }

  // ════════════════════════════════════════════════════════════
  // Episode Operations
  // ════════════════════════════════════════════════════════════

  upsertEpisode(input: import('@/server/knowledge/repository').UpsertKnowledgeEpisodeInput) {
    return this.episodeRepo.upsertEpisode(input);
  }

  listEpisodes(filter: ListKnowledgeFilter) {
    return this.episodeRepo.listEpisodes(filter);
  }

  // ════════════════════════════════════════════════════════════
  // Meeting Ledger Operations
  // ════════════════════════════════════════════════════════════

  upsertMeetingLedger(input: import('@/server/knowledge/repository').UpsertMeetingLedgerInput) {
    return this.ledgerRepo.upsertMeetingLedger(input);
  }

  listMeetingLedger(filter: ListKnowledgeFilter) {
    return this.ledgerRepo.listMeetingLedger(filter);
  }

  // ════════════════════════════════════════════════════════════
  // Audit Operations
  // ════════════════════════════════════════════════════════════

  insertRetrievalAudit(input: import('@/server/knowledge/repository').InsertRetrievalAuditInput) {
    return this.auditRepo.insertRetrievalAudit(input);
  }

  listRetrievalAudit(filter: { userId: string; personaId: string; limit?: number }) {
    return this.auditRepo.listRetrievalAudit(filter);
  }

  // ════════════════════════════════════════════════════════════
  // Stats & Maintenance
  // ════════════════════════════════════════════════════════════

  getKnowledgeStats(userId: string, personaId: string): KnowledgeStats {
    const episodeCount = Number(
      (
        this.db
          .prepare(
            'SELECT COUNT(*) as c FROM knowledge_episodes WHERE user_id = ? AND persona_id = ?',
          )
          .get(userId, personaId) as { c: number }
      ).c || 0,
    );

    const ledgerCount = Number(
      (
        this.db
          .prepare(
            'SELECT COUNT(*) as c FROM knowledge_meeting_ledger WHERE user_id = ? AND persona_id = ?',
          )
          .get(userId, personaId) as { c: number }
      ).c || 0,
    );

    const retrievalErrorCount = Number(
      (
        this.db
          .prepare(
            'SELECT COUNT(*) as c FROM knowledge_retrieval_audit WHERE user_id = ? AND persona_id = ? AND had_error = 1',
          )
          .get(userId, personaId) as { c: number }
      ).c || 0,
    );

    const latestCheckpoint = this.db
      .prepare(
        `
        SELECT MAX(updated_at) as updated_at
        FROM knowledge_ingestion_checkpoints
      `,
      )
      .get() as { updated_at?: string } | undefined;

    const latestIngestionAt = parseIso(latestCheckpoint?.updated_at) || null;
    const ingestionLagMs = latestIngestionAt
      ? Math.max(0, Date.now() - Date.parse(latestIngestionAt))
      : 0;

    return {
      episodeCount,
      ledgerCount,
      retrievalErrorCount,
      latestIngestionAt,
      ingestionLagMs,
    };
  }

  deleteKnowledgeByScope(userId: string, personaId: string): number {
    const tx = this.db.transaction((uid: string, pid: string) => {
      const episodeDeleted = Number(
        this.db
          .prepare('DELETE FROM knowledge_episodes WHERE user_id = ? AND persona_id = ?')
          .run(uid, pid).changes || 0,
      );
      const ledgerDeleted = Number(
        this.db
          .prepare('DELETE FROM knowledge_meeting_ledger WHERE user_id = ? AND persona_id = ?')
          .run(uid, pid).changes || 0,
      );
      const auditDeleted = Number(
        this.db
          .prepare('DELETE FROM knowledge_retrieval_audit WHERE user_id = ? AND persona_id = ?')
          .run(uid, pid).changes || 0,
      );
      return episodeDeleted + ledgerDeleted + auditDeleted;
    });

    return tx(userId, personaId);
  }

  pruneKnowledgeBefore(input: {
    userId: string;
    personaId: string;
    beforeIso: string;
    dryRun?: boolean;
  }): { episodes: number; ledger: number; audits: number } {
    const cutoff = parseIso(input.beforeIso);
    if (!cutoff) {
      return { episodes: 0, ledger: 0, audits: 0 };
    }

    const countOnly = (sql: string): number =>
      Number(
        (this.db.prepare(sql).get(input.userId, input.personaId, cutoff) as { c: number }).c || 0,
      );

    const episodes = countOnly(
      'SELECT COUNT(*) as c FROM knowledge_episodes WHERE user_id = ? AND persona_id = ? AND COALESCE(event_at, updated_at) < ?',
    );
    const ledger = countOnly(
      'SELECT COUNT(*) as c FROM knowledge_meeting_ledger WHERE user_id = ? AND persona_id = ? AND COALESCE(event_at, updated_at) < ?',
    );
    const audits = countOnly(
      'SELECT COUNT(*) as c FROM knowledge_retrieval_audit WHERE user_id = ? AND persona_id = ? AND created_at < ?',
    );

    if (input.dryRun) {
      return { episodes, ledger, audits };
    }

    this.db
      .prepare(
        'DELETE FROM knowledge_episodes WHERE user_id = ? AND persona_id = ? AND COALESCE(event_at, updated_at) < ?',
      )
      .run(input.userId, input.personaId, cutoff);
    this.db
      .prepare(
        'DELETE FROM knowledge_meeting_ledger WHERE user_id = ? AND persona_id = ? AND COALESCE(event_at, updated_at) < ?',
      )
      .run(input.userId, input.personaId, cutoff);
    this.db
      .prepare(
        'DELETE FROM knowledge_retrieval_audit WHERE user_id = ? AND persona_id = ? AND created_at < ?',
      )
      .run(input.userId, input.personaId, cutoff);

    return { episodes, ledger, audits };
  }

  // ════════════════════════════════════════════════════════════
  // Event Operations (delegated to EventRepository)
  // ════════════════════════════════════════════════════════════

  upsertEvent(input: UpsertKnowledgeEventInput): void {
    return this.eventRepo.upsertEvent(input);
  }

  appendEventSources(eventId: string, newSeqs: number[], newSummary?: string): void {
    return this.eventRepo.appendEventSources(eventId, newSeqs, newSummary);
  }

  listEvents(filter: KnowledgeEventFilter, limit?: number) {
    return this.eventRepo.listEvents(filter, limit);
  }

  findOverlappingEvents(filter: KnowledgeEventFilter) {
    return this.eventRepo.findOverlappingEvents(filter);
  }

  countUniqueDays(filter: KnowledgeEventFilter) {
    return this.eventRepo.countUniqueDays(filter);
  }

  // ════════════════════════════════════════════════════════════
  // Entity Graph Operations (delegated to EntityRepository)
  // ════════════════════════════════════════════════════════════

  upsertEntity(
    input: Omit<
      import('@/server/knowledge/entityGraph').KnowledgeEntity,
      'createdAt' | 'updatedAt'
    >,
  ) {
    return this.entityRepo.upsertEntity(input);
  }

  addAlias(
    alias: Omit<import('@/server/knowledge/entityGraph').EntityAlias, 'id' | 'createdAt'>,
  ): void {
    return this.entityRepo.addAlias(alias);
  }

  addRelation(
    relation: Omit<
      import('@/server/knowledge/entityGraph').EntityRelation,
      'id' | 'createdAt' | 'updatedAt'
    >,
  ): void {
    return this.entityRepo.addRelation(relation);
  }

  updateEntityProperties(entityId: string, properties: Record<string, string>): void {
    return this.entityRepo.updateEntityProperties(entityId, properties);
  }

  resolveEntity(text: string, filter: EntityGraphFilter) {
    return this.entityRepo.resolveEntity(text, filter);
  }

  resolveEntityByRelation(relation: string, owner: 'persona' | 'user', filter: EntityGraphFilter) {
    return this.entityRepo.resolveEntityByRelation(relation, owner, filter);
  }

  listEntities(filter: EntityGraphFilter, limit?: number) {
    return this.entityRepo.listEntities(filter, limit);
  }

  getAliasCountsByEntityIds(entityIds: string[]) {
    return this.entityRepo.getAliasCountsByEntityIds(entityIds);
  }

  listRelationsByEntityIds(entityIds: string[]) {
    return this.entityRepo.listRelationsByEntityIds(entityIds);
  }

  getEntityWithRelations(entityId: string) {
    return this.entityRepo.getEntityWithRelations(entityId);
  }

  getRelatedEntities(entityId: string, relationType?: string) {
    return this.entityRepo.getRelatedEntities(entityId, relationType);
  }

  findPath(fromEntityId: string, toEntityId: string, maxDepth?: number) {
    return this.entityRepo.findPath(fromEntityId, toEntityId, maxDepth);
  }

  deleteEntity(entityId: string): void {
    return this.entityRepo.deleteEntity(entityId);
  }

  deleteEntitiesByName(name: string, filter: EntityGraphFilter): number {
    return this.entityRepo.deleteEntitiesByName(name, filter);
  }

  // ════════════════════════════════════════════════════════════
  // Conversation Summary Operations (delegated to SummaryRepository)
  // ════════════════════════════════════════════════════════════

  upsertConversationSummary(
    input: import('@/server/knowledge/repository').UpsertConversationSummaryInput,
  ) {
    return this.summaryRepo.upsertConversationSummary(input);
  }

  listConversationSummaries(filter: {
    userId: string;
    personaId: string;
    conversationId?: string;
    limit?: number;
  }) {
    return this.summaryRepo.listConversationSummaries(filter);
  }
}
