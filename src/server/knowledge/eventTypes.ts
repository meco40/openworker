export const KNOWN_EVENT_TYPES = [
  'shared_sleep',
  'visit',
  'trip',
  'meeting',
  'activity',
  'meal',
  'appointment',
  'celebration',
  'conflict',
  'reconciliation',
  'emotion',
  'location_change',
  'routine',
  'milestone',
  'relationship_change',
  'health',
  'finance',
] as const;

export type KnowledgeEventType = (typeof KNOWN_EVENT_TYPES)[number] | string;

export interface KnowledgeEvent {
  id: string;
  userId: string;
  personaId: string;
  conversationId: string;
  eventType: KnowledgeEventType;
  speakerRole: 'assistant' | 'user';
  speakerEntity: string;
  subjectEntity: string;
  counterpartEntity: string;
  relationLabel: string | null;
  startDate: string;
  endDate: string;
  dayCount: number;
  sourceSeqJson: string;
  sourceSummary: string;
  isConfirmation: boolean;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertKnowledgeEventInput {
  id: string;
  userId: string;
  personaId: string;
  conversationId: string;
  eventType: KnowledgeEventType;
  speakerRole: 'assistant' | 'user';
  speakerEntity: string;
  subjectEntity: string;
  counterpartEntity: string;
  relationLabel?: string | null;
  startDate: string;
  endDate: string;
  dayCount: number;
  sourceSeqJson?: string;
  sourceSummary?: string;
  isConfirmation?: boolean;
  confidence?: number;
}

export interface KnowledgeEventFilter {
  userId: string;
  personaId: string;
  eventType?: KnowledgeEventType;
  speakerRole?: 'assistant' | 'user';
  subjectEntity?: string;
  counterpartEntity?: string;
  relationLabel?: string;
  from?: string;
  to?: string;
}

export interface EventAggregationResult {
  uniqueDayCount: number;
  uniqueDays: string[];
  eventCount: number;
  events: KnowledgeEvent[];
}
