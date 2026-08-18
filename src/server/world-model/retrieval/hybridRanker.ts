export type RankSource = 'structured' | 'fulltext' | 'vector';

export interface RankCandidate {
  id: string;
  source: RankSource;
  score: number;
  active: boolean;
  queryIntent?: string;
}

export interface RankedHit extends RankCandidate {
  combined: number;
}

/**
 * Phase 11: Hybrid Ranking.
 *
 * Reihenfolge (Plan): strukturierte Wahrheit > Volltext > Vector; aktive
 * Wahrheit schlaegt historische Aehnlichkeit. Der kombinierte Score ist eine
 * gewichtete Summe, bei der die Quelle als Prioritaet und `active` als
 * Multiplikator einfliesst.
 */
export function hybridRank(candidates: RankCandidate[]): RankedHit[] {
  const triage: Record<RankSource, number> = {
    structured: 100,
    fulltext: 50,
    vector: 10,
  };
  const activeMultiplier = 1.0;
  const inactiveMultiplier = 0.25;

  return candidates
    .map((candidate) => {
      const sourceWeight = triage[candidate.source] ?? 0;
      const stateMultiplier = candidate.active ? activeMultiplier : inactiveMultiplier;
      const intentBonus = candidate.queryIntent && candidate.queryIntent !== 'generic' ? 0.9 : 1.0;
      const combined = (sourceWeight + candidate.score) * stateMultiplier * intentBonus;
      return { ...candidate, combined };
    })
    .sort((a, b) => b.combined - a.combined);
}

/**
 * Unterdrueckt widerrufene/abgesagte Ergebnisse: Nur `active`-Kandidaten einer
 * hohen Quelle tauchen vor inaktiven Vektor-Treffern auf. Aktive Wahrheit
 * schlaegt immer historische Aehnlichkeit.
 */
export function suppressInactiveBeforeLowerSource(
  ranked: RankedHit[],
  minActiveSource: RankSource = 'vector',
): RankedHit[] {
  const order: Record<RankSource, number> = { structured: 0, fulltext: 1, vector: 2 };
  return ranked.filter((hit) => hit.active || (order[hit.source] ?? 2) < order[minActiveSource]);
}
