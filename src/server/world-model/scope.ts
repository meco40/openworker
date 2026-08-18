/**
 * Verpflichtender World-Model-Scope (Plan Phase 1: Schema/Historie/Mandant).
 * Jeder produktive Zugriff auf World-Model-Daten verwendet `WorldModelScope`
 * mit user/persona/workspace. Ungescopte Lesezugriffe werden so vermieden.
 */
export interface WorldModelScope {
  userId: string;
  personaId: string;
  workspaceId?: string;
}

export function scopeParts(scope: WorldModelScope): {
  userId: string;
  personaId: string;
  workspaceId: string;
} {
  return {
    userId: scope.userId,
    personaId: scope.personaId,
    workspaceId: scope.workspaceId ?? '',
  };
}

export function scopeKey(scope: WorldModelScope): string {
  return `${scope.userId}:${scope.personaId}:${scope.workspaceId ?? ''}`;
}

export function sameScope(a: WorldModelScope, b: WorldModelScope): boolean {
  return (
    a.userId === b.userId &&
    a.personaId === b.personaId &&
    (a.workspaceId ?? '') === (b.workspaceId ?? '')
  );
}

/**
 * Where-Klausel + Parameter für scoped SQL abgeleitet aus einer Position.
 * Liefert `{"clause": "user_id = $1 AND persona_id = $2 AND workspace_id = $3",
 * "values": [userId, personaId, workspaceId], "nextIndex": 4}`.
 */
export function scopeWhere(
  scope: WorldModelScope,
  startIndex = 1,
): {
  clause: string;
  values: string[];
  nextIndex: number;
} {
  const parts = scopeParts(scope);
  const values = [parts.userId, parts.personaId, parts.workspaceId];
  const clause = values
    .map((_, index) => {
      const param = `$${startIndex + index}`;
      const column = ['user_id', 'persona_id', 'workspace_id'][index];
      return `${column} = ${param}`;
    })
    .join(' AND ');
  return { clause, values, nextIndex: startIndex + values.length };
}
