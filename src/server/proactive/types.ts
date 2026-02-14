export type ProactiveCandidateKey = string;

export type ProactiveDecisionType = 'suggest' | 'defer';

export interface ProactiveMessageInput {
  role: 'user' | 'agent' | 'system';
  content: string;
  createdAt?: string;
}

export interface ProactiveSignalInput {
  userId: string;
  personaId: string;
  signalKey: string;
  weight: number;
  source: string;
  createdAt: string;
}

export interface ProactiveSummaryRow {
  signalKey: string;
  totalWeight: number;
  occurrences: number;
  lastSeenAt: string;
}

export interface ProactiveDecision {
  id: string;
  userId: string;
  personaId: string;
  candidateKey: ProactiveCandidateKey;
  decision: ProactiveDecisionType;
  score: number;
  reason: string;
  createdAt: string;
}
