import type { StoredMessage } from '@/server/channels/messages/repository';
import type {
  KnowledgeRepository,
} from '@/server/knowledge/repository';
import type { EntityGraphFilter, EntityLookupResult } from '@/server/knowledge/entityGraph';
import type { PersonaType } from '@/server/knowledge/personaStrategies';

export interface MemoryRecallLike {
  recallDetailed: (
    personaId: string,
    query: string,
    limit?: number,
    userId?: string,
  ) => Promise<{ context: string; matches: Array<{ node: { id: string; content?: string } }> }>;
}

export interface MessageLookupRepository {
  listMessages: (
    conversationId: string,
    limit?: number,
    before?: string,
    userId?: string,
  ) => StoredMessage[];
}

export interface RetrievalKnowledgeRepository {
  listMeetingLedger: KnowledgeRepository['listMeetingLedger'];
  listEpisodes: KnowledgeRepository['listEpisodes'];
  insertRetrievalAudit: KnowledgeRepository['insertRetrievalAudit'];
  countUniqueDays?: KnowledgeRepository['countUniqueDays'];
  // Entity Graph (optional)
  resolveEntity?: (text: string, filter: EntityGraphFilter) => EntityLookupResult | null;
  getEntityWithRelations?: KnowledgeRepository['getEntityWithRelations'];
  getRelatedEntities?: KnowledgeRepository['getRelatedEntities'];
}

export interface KnowledgeRetrievalInput {
  userId: string;
  personaId: string;
  conversationId?: string;
  query: string;
}

export interface KnowledgeRecallProbeInput {
  userId: string;
  personaId: string;
  query: string;
}

export interface KnowledgeRetrievalSections {
  [key: string]: string;
  answerDraft: string;
  keyDecisions: string;
  openPoints: string;
  evidence: string;
}

export interface KnowledgeRetrievalResult {
  context: string;
  sections: KnowledgeRetrievalSections;
  references: string[];
  tokenCount: number;
  computedAnswer?: string | null;
}

export interface KnowledgeRetrievalServiceOptions {
  maxContextTokens: number;
  knowledgeRepository: RetrievalKnowledgeRepository;
  /** Optional — when null/undefined, semantic recall is skipped. */
  memoryService?: MemoryRecallLike | null;
  messageRepository: MessageLookupRepository;
  /** Optional callback to look up the stored persona memory type from the persona DB. */
  getPersonaMemoryType?: (personaId: string) => PersonaType | null;
}
