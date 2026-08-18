import type { Modality, EventStatus } from '@/server/world-model/types';

export interface ProjectedAssertion {
  subject: string;
  predicate: string;
  objectValue?: string;
  modality: Modality;
  confidence: number;
  sourceMessageSeq: number;
}

export interface ProjectedEvent {
  title: string;
  eventType: string;
  scheduledFor?: string;
  endsAt?: string;
  status: EventStatus;
  sourceMessageSeq: number;
}

export interface ProjectedEntity {
  canonicalName: string;
  category: string;
  owner: 'persona' | 'user' | 'shared';
  sourceMessageSeq: number;
}

export interface ProjectedRelation {
  sourceEntity: string;
  targetEntity: string;
  relationType: string;
  confidence: number;
  sourceMessageSeq: number;
}

export interface ProjectedOpenLoop {
  type: 'clarification' | 'confirmation' | 'event_outcome' | 'dependency' | 'missing_context';
  question?: string;
  deduplicationKey: string;
  sourceMessageSeq: number;
}

export interface ProjectedTask {
  title: string;
  requester: string;
  assignee: string;
  sourceMessageSeq: number;
}

/**
 * Normalisierte, persistierbare Projektion eines Conversation-Windows.
 * Alle Artefakt-IDs werden deterministisch (Scope + Quellsequenz + Inhalt)
 * abgeleitet; ein Replay desselben Windows erzeugt exakt denselben Zustand.
 */
export interface WorldModelProjection {
  assertions: ProjectedAssertion[];
  events: ProjectedEvent[];
  entities: ProjectedEntity[];
  relations: ProjectedRelation[];
  openLoops: ProjectedOpenLoop[];
  tasks: ProjectedTask[];
  confidenceSummary: { total: number; confident: number };
}
