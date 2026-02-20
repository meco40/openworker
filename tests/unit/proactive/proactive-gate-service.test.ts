import { describe, expect, it } from 'vitest';
import type {
  ProactiveDecision,
  ProactiveSignalInput,
  ProactiveSummaryRow,
} from '@/server/proactive/types';
import type { ProactiveRepository } from '@/server/proactive/repository';
import { ProactiveGateService } from '@/server/proactive/service';

class InMemoryProactiveRepository implements ProactiveRepository {
  private readonly signals: ProactiveSignalInput[] = [];
  private readonly decisions: ProactiveDecision[] = [];

  insertSignals(signals: ProactiveSignalInput[]): number {
    this.signals.push(...signals);
    return signals.length;
  }

  summarizeSignals(userId: string, personaId: string, sinceIso: string): ProactiveSummaryRow[] {
    const since = new Date(sinceIso).getTime();
    const map = new Map<string, ProactiveSummaryRow>();
    for (const signal of this.signals) {
      if (signal.userId !== userId || signal.personaId !== personaId) continue;
      if (new Date(signal.createdAt).getTime() < since) continue;

      const existing = map.get(signal.signalKey);
      if (!existing) {
        map.set(signal.signalKey, {
          signalKey: signal.signalKey,
          totalWeight: signal.weight,
          occurrences: 1,
          lastSeenAt: signal.createdAt,
        });
        continue;
      }

      existing.totalWeight += signal.weight;
      existing.occurrences += 1;
      if (signal.createdAt > existing.lastSeenAt) {
        existing.lastSeenAt = signal.createdAt;
      }
    }
    return Array.from(map.values());
  }

  listRecentDecisions(userId: string, personaId: string, limit = 20): ProactiveDecision[] {
    return this.decisions
      .filter((item) => item.userId === userId && item.personaId === personaId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  insertDecision(
    input: Omit<ProactiveDecision, 'id' | 'createdAt'> & { createdAt?: string },
  ): ProactiveDecision {
    const decision: ProactiveDecision = {
      id: `d-${this.decisions.length + 1}`,
      createdAt: input.createdAt || new Date().toISOString(),
      ...input,
    };
    this.decisions.push(decision);
    return decision;
  }
}

describe('ProactiveGateService', () => {
  it('suggests gold watcher when strong evidence exists', () => {
    const repo = new InMemoryProactiveRepository();
    const service = new ProactiveGateService(repo);
    const now = '2026-02-14T12:00:00.000Z';

    service.ingestMessages(
      'user-1',
      'persona-1',
      [
        {
          role: 'user',
          content: 'Ich investiere in Gold und verfolge den Goldpreis täglich.',
          createdAt: now,
        },
        { role: 'user', content: 'Gibt es Nachrichten zu Gold heute?', createdAt: now },
      ],
      now,
    );

    const decisions = service.evaluate('user-1', 'persona-1', now);
    const gold = decisions.find((item) => item.candidateKey === 'topic_watcher:gold');
    expect(gold).toBeDefined();
    expect(gold?.decision).toBe('suggest');
    expect(gold?.score).toBeGreaterThanOrEqual(0.72);
  });

  it('does not suggest when evidence is weak', () => {
    const repo = new InMemoryProactiveRepository();
    const service = new ProactiveGateService(repo);
    const now = '2026-02-14T12:00:00.000Z';

    service.ingestMessages(
      'user-1',
      'persona-1',
      [{ role: 'user', content: 'Gold klingt interessant.', createdAt: now }],
      now,
    );

    const decisions = service.evaluate('user-1', 'persona-1', now);
    const gold = decisions.find((item) => item.candidateKey === 'topic_watcher:gold');
    expect(gold?.decision).toBe('defer');
    expect(repo.listRecentDecisions('user-1', 'persona-1', 10)).toHaveLength(0);
  });

  it('respects cooldown and avoids repeated suggest decisions', () => {
    const repo = new InMemoryProactiveRepository();
    const service = new ProactiveGateService(repo);
    const first = '2026-02-14T08:00:00.000Z';
    const second = '2026-02-14T10:00:00.000Z';

    service.ingestMessages(
      'user-1',
      'persona-1',
      [
        {
          role: 'user',
          content: 'Ich investiere in Gold und schaue den Preis stündlich.',
          createdAt: first,
        },
        { role: 'user', content: 'Bitte melde starke Goldbewegungen.', createdAt: first },
      ],
      first,
    );
    const firstRun = service.evaluate('user-1', 'persona-1', first);
    expect(
      firstRun.some(
        (item) => item.candidateKey === 'topic_watcher:gold' && item.decision === 'suggest',
      ),
    ).toBe(true);

    const secondRun = service.evaluate('user-1', 'persona-1', second);
    expect(
      secondRun.some(
        (item) => item.candidateKey === 'topic_watcher:gold' && item.decision === 'suggest',
      ),
    ).toBe(false);
  });
});
