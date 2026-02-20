import type { ProactiveDecision, ProactiveSignalInput, ProactiveSummaryRow } from '@/server/proactive/types';

export interface ProactiveRepository {
  insertSignals(signals: ProactiveSignalInput[]): number;
  summarizeSignals(userId: string, personaId: string, sinceIso: string): ProactiveSummaryRow[];
  listRecentDecisions(userId: string, personaId: string, limit?: number): ProactiveDecision[];
  insertDecision(
    input: Omit<ProactiveDecision, 'id' | 'createdAt'> & { createdAt?: string },
  ): ProactiveDecision;
}
