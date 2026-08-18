export interface RetentionPolicy {
  observationsDays: number;
  assertionsDays: number;
  eventsDays: number;
  openLoopsDays: number;
  outboxDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  observationsDays: 365,
  assertionsDays: 1095,
  eventsDays: 365,
  openLoopsDays: 90,
  outboxDays: 30,
};

export interface ScopeSelector {
  userId?: string;
  personaId?: string;
  workspaceId?: string;
}

/**
 * Phase 15 (Datenschutz/Retention): Baut idempotente DELETE-Befehle fuer
 * Export/Loeschung/Retention ueber World Model und Projektionen. Die tatsaechliche
 * Ausfuehrung erfolgt durch den Aufrufer gegen die PostgreSQL-Instanz; diese
 * Funktion liefert deterministische, scoped SQL-Bausteine und die Retention-Entscheidung.
 */
export function buildScopeWhere(
  scope: ScopeSelector,
  startIndex = 1,
): {
  clause: string;
  values: string[];
} {
  const pairs: Array<[string, string | undefined]> = [
    ['user_id', scope.userId],
    ['persona_id', scope.personaId],
    ['workspace_id', scope.workspaceId],
  ];
  const clauses: string[] = [];
  const values: string[] = [];
  let index = startIndex;
  for (const [column, value] of pairs) {
    if (value === undefined) continue;
    clauses.push(`${column} = $${index}`);
    values.push(value);
    index += 1;
  }
  return { clause: clauses.join(' AND '), values };
}

export function retentionCutoffDays(policy: RetentionPolicy, kind: keyof RetentionPolicy): number {
  return Math.max(0, policy[kind]);
}
