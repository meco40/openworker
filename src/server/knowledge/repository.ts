import type {
  EventAggregationResult,
  KnowledgeEvent,
  KnowledgeEventFilter,
  UpsertKnowledgeEventInput,
} from '@/server/knowledge/eventTypes';
import type {
  EntityAlias,
  EntityGraphFilter,
  EntityLookupResult,
  EntityRelation,
  KnowledgeEntity,
} from '@/server/knowledge/entityGraph';

export interface KnowledgeSourceRef {
  seq: number;
  quote: string;
}

export interface KnowledgeCheckpoint {
  conversationId: string;
  personaId: string;
  lastSeq: number;
  updatedAt: string;
}

export interface UpsertKnowledgeCheckpointInput {
  conversationId: string;
  personaId: string;
  lastSeq: number;
}

export interface KnowledgeEpisode {
  id: string;
  userId: string;
  personaId: string;
  conversationId: string;
  topicKey: string;
  counterpart: string | null;
  teaser: string;
  episode: string;
  facts: string[];
  sourceSeqStart: number;
  sourceSeqEnd: number;
  sourceRefs: KnowledgeSourceRef[];
  eventAt: string | null;
  updatedAt: string;
}

export interface UpsertKnowledgeEpisodeInput {
  userId: string;
  personaId: string;
  conversationId: string;
  topicKey: string;
  counterpart?: string | null;
  teaser: string;
  episode: string;
  facts: string[];
  sourceSeqStart: number;
  sourceSeqEnd: number;
  sourceRefs: KnowledgeSourceRef[];
  eventAt?: string | null;
}

export interface MeetingLedgerEntry {
  id: string;
  userId: string;
  personaId: string;
  conversationId: string;
  topicKey: string;
  counterpart: string | null;
  eventAt: string | null;
  participants: string[];
  decisions: string[];
  negotiatedTerms: string[];
  openPoints: string[];
  actionItems: string[];
  sourceRefs: KnowledgeSourceRef[];
  confidence: number;
  updatedAt: string;
}

export interface UpsertMeetingLedgerInput {
  userId: string;
  personaId: string;
  conversationId: string;
  topicKey: string;
  counterpart?: string | null;
  eventAt?: string | null;
  participants: string[];
  decisions: string[];
  negotiatedTerms: string[];
  openPoints: string[];
  actionItems: string[];
  sourceRefs: KnowledgeSourceRef[];
  confidence?: number;
}

export interface RetrievalAuditEntry {
  id: string;
  userId: string;
  personaId: string;
  conversationId: string;
  query: string;
  stageStats: Record<string, number>;
  tokenCount: number;
  hadError: boolean;
  errorMessage: string | null;
  createdAt: string;
}

export interface InsertRetrievalAuditInput {
  userId: string;
  personaId: string;
  conversationId: string;
  query: string;
  stageStats: Record<string, number>;
  tokenCount: number;
  hadError: boolean;
  errorMessage?: string | null;
}

export interface KnowledgeStats {
  episodeCount: number;
  ledgerCount: number;
  retrievalErrorCount: number;
  latestIngestionAt: string | null;
  ingestionLagMs: number;
}

export interface ListKnowledgeFilter {
  userId: string;
  personaId: string;
  counterpart?: string;
  topicKey?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface ConversationSummaryEntry {
  id: string;
  userId: string;
  personaId: string;
  conversationId: string;
  summaryText: string;
  keyTopics: string[];
  entitiesMentioned: string[];
  emotionalTone: string | null;
  messageCount: number;
  timeRangeStart: string;
  timeRangeEnd: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertConversationSummaryInput {
  userId: string;
  personaId: string;
  conversationId: string;
  summaryText: string;
  keyTopics: string[];
  entitiesMentioned: string[];
  emotionalTone: string | null;
  messageCount: number;
  timeRangeStart: string;
  timeRangeEnd: string;
}

export interface KnowledgeRepository {
  getIngestionCheckpoint(conversationId: string, personaId: string): KnowledgeCheckpoint | null;
  upsertIngestionCheckpoint(input: UpsertKnowledgeCheckpointInput): KnowledgeCheckpoint;

  upsertEpisode(input: UpsertKnowledgeEpisodeInput): KnowledgeEpisode;
  listEpisodes(filter: ListKnowledgeFilter): KnowledgeEpisode[];

  upsertMeetingLedger(input: UpsertMeetingLedgerInput): MeetingLedgerEntry;
  listMeetingLedger(filter: ListKnowledgeFilter): MeetingLedgerEntry[];

  insertRetrievalAudit(input: InsertRetrievalAuditInput): RetrievalAuditEntry;
  listRetrievalAudit(filter: {
    userId: string;
    personaId: string;
    limit?: number;
  }): RetrievalAuditEntry[];

  getKnowledgeStats(userId: string, personaId: string): KnowledgeStats;

  deleteKnowledgeByScope(userId: string, personaId: string): number;
  pruneKnowledgeBefore(input: {
    userId: string;
    personaId: string;
    beforeIso: string;
    dryRun?: boolean;
  }): { episodes: number; ledger: number; audits: number };

  // Event methods (Phase 1)
  upsertEvent(input: UpsertKnowledgeEventInput): void;
  appendEventSources(eventId: string, newSeqs: number[], newSummary?: string): void;
  listEvents(filter: KnowledgeEventFilter, limit?: number): KnowledgeEvent[];
  findOverlappingEvents(filter: KnowledgeEventFilter): KnowledgeEvent[];
  countUniqueDays(filter: KnowledgeEventFilter): EventAggregationResult;

  // Entity Graph methods (Phase 2)
  upsertEntity(input: Omit<KnowledgeEntity, 'createdAt' | 'updatedAt'>): KnowledgeEntity;
  addAlias(alias: Omit<EntityAlias, 'id' | 'createdAt'>): void;
  addRelation(relation: Omit<EntityRelation, 'id' | 'createdAt' | 'updatedAt'>): void;
  updateEntityProperties(entityId: string, properties: Record<string, string>): void;
  resolveEntity(text: string, filter: EntityGraphFilter): EntityLookupResult | null;
  resolveEntityByRelation(
    relation: string,
    owner: 'persona' | 'user',
    filter: EntityGraphFilter,
  ): EntityLookupResult | null;
  listEntities(filter: EntityGraphFilter, limit?: number): KnowledgeEntity[];
  getAliasCountsByEntityIds?(entityIds: string[]): Record<string, number>;
  listRelationsByEntityIds?(entityIds: string[]): EntityRelation[];
  getEntityWithRelations(entityId: string): {
    entity: KnowledgeEntity;
    relations: EntityRelation[];
    aliases: EntityAlias[];
  };
  getRelatedEntities(entityId: string, relationType?: string): KnowledgeEntity[];
  findPath(fromEntityId: string, toEntityId: string, maxDepth?: number): EntityRelation[];
  deleteEntity(entityId: string): void;
  deleteEntitiesByName(name: string, filter: EntityGraphFilter): number;

  // Conversation Summary methods (Phase 3)
  upsertConversationSummary(input: UpsertConversationSummaryInput): ConversationSummaryEntry;
  listConversationSummaries(filter: {
    userId: string;
    personaId: string;
    conversationId?: string;
    limit?: number;
  }): ConversationSummaryEntry[];
}
