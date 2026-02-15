export interface KnowledgeIngestionCheckpoint {
  userId: string;
  personaId: string;
  conversationId: string;
  lastProcessedSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeIngestionCheckpointInput {
  userId: string;
  personaId: string;
  conversationId: string;
  lastProcessedSeq: number;
  updatedAt?: string;
}

export interface KnowledgeEpisode {
  id: string;
  userId: string;
  personaId: string;
  topicKey: string;
  counterpart: string;
  date: string;
  teaser: string;
  summary: string;
  sourceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeEpisodeInput {
  id: string;
  userId: string;
  personaId: string;
  topicKey: string;
  counterpart: string;
  date: string;
  teaser: string;
  summary: string;
  sourceRefs: string[];
  updatedAt?: string;
}

export type KnowledgeEpisodeUpdateInput = KnowledgeEpisodeInput;

export interface KnowledgeMeetingLedgerEntry {
  id: string;
  userId: string;
  personaId: string;
  counterpart: string;
  topicKey: string;
  date: string;
  decisions: string[];
  negotiatedTerms: string[];
  openPoints: string[];
  actionItems: string[];
  sourceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeMeetingLedgerEntryInput {
  id: string;
  userId: string;
  personaId: string;
  counterpart: string;
  topicKey: string;
  date: string;
  decisions: string[];
  negotiatedTerms: string[];
  openPoints: string[];
  actionItems: string[];
  sourceRefs: string[];
  updatedAt?: string;
}

export type KnowledgeMeetingLedgerEntryUpdateInput = KnowledgeMeetingLedgerEntryInput;

export interface KnowledgeRetrievalAudit {
  id: string;
  userId: string;
  personaId: string;
  queryText: string;
  counterpart: string | null;
  topicKey: string | null;
  date: string | null;
  resultIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeRetrievalAuditInput {
  id: string;
  userId: string;
  personaId: string;
  queryText: string;
  counterpart?: string | null;
  topicKey?: string | null;
  date?: string | null;
  resultIds: string[];
  updatedAt?: string;
}

export type KnowledgeRetrievalAuditUpdateInput = KnowledgeRetrievalAuditInput;

export interface KnowledgeRepository {
  close(): void;

  upsertIngestionCheckpoint(
    input: KnowledgeIngestionCheckpointInput,
  ): KnowledgeIngestionCheckpoint;
  getIngestionCheckpoint(
    userId: string,
    personaId: string,
    conversationId: string,
  ): KnowledgeIngestionCheckpoint | null;
  deleteIngestionCheckpoint(userId: string, personaId: string, conversationId: string): number;

  insertEpisode(input: KnowledgeEpisodeInput): KnowledgeEpisode;
  getEpisode(userId: string, personaId: string, id: string): KnowledgeEpisode | null;
  updateEpisode(input: KnowledgeEpisodeUpdateInput): number;
  deleteEpisode(userId: string, personaId: string, id: string): number;

  insertMeetingLedgerEntry(input: KnowledgeMeetingLedgerEntryInput): KnowledgeMeetingLedgerEntry;
  getMeetingLedgerEntry(
    userId: string,
    personaId: string,
    id: string,
  ): KnowledgeMeetingLedgerEntry | null;
  updateMeetingLedgerEntry(input: KnowledgeMeetingLedgerEntryUpdateInput): number;
  deleteMeetingLedgerEntry(userId: string, personaId: string, id: string): number;

  insertRetrievalAudit(input: KnowledgeRetrievalAuditInput): KnowledgeRetrievalAudit;
  getRetrievalAudit(userId: string, personaId: string, id: string): KnowledgeRetrievalAudit | null;
  updateRetrievalAudit(input: KnowledgeRetrievalAuditUpdateInput): number;
  deleteRetrievalAudit(userId: string, personaId: string, id: string): number;
}
