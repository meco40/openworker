import { createHash } from 'node:crypto';

import type { WorldModelScope } from '@/server/world-model/scope';

export interface IdempotencyParts {
  scope: WorldModelScope;
  sourceMessageSeq: number;
  kind: string;
  content: string;
}

/**
 * Deterministische Artefakt-ID: Scope + Quellsequenz + Art + Inhalt.
 * Replay desselben Windows erzeugt exakt dieselbe ID -> idempotente Projektion.
 */
export function deriveArtifactKey(parts: IdempotencyParts): string {
  return createHash('sha256')
    .update(
      [
        parts.scope.userId,
        parts.scope.personaId,
        parts.scope.workspaceId ?? '',
        parts.kind,
        String(parts.sourceMessageSeq),
        parts.content,
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 32);
}

export function stableDedupKey(parts: IdempotencyParts, seed = ''): string {
  return `projected:${deriveArtifactKey({ ...parts, content: `${seed}:${parts.content}` })}`;
}

/**
 * Hash eines Textes, um "identische historische Wiederholung" von
 * "gleichzeitig aktiver Wahrheit" zu unterscheiden. Wird fuer Assertions
 * verwendet: gleicher Text + gleiche Quelle = idempotent.
 */
export function textFingerprint(text: string): string {
  return createHash('sha1').update(text.trim().toLowerCase()).digest('hex').slice(0, 16);
}
