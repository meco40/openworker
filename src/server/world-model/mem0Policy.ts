import { getWorldModelConfig } from '@/server/world-model/config';

/**
 * Phase 14: Mem0-Reduktions-Policy.
 *
 * - `isMem0PrimaryMemory()`: Mem0 ist noch die faktische Wahrheit (Legacy/Shadow).
 * - `isMem0PreferencesOnly()`: Mem0 speichert nur Praeferenzen/Stil/Gewohnheiten.
 * - `isMem0FactualWriteBlocked()`: Im Canonical-Modus duerfen keine faktischen
 *   Facts/Events/Tasks mehr nach Mem0 geschrieben werden.
 * - `allowedMem0Types()`: Liste der Memory-Typen, die im aktuellen Modus nach
 *   Mem0 geschrieben werden duerfen.
 */
export function isMem0PrimaryMemory(): boolean {
  return !getWorldModelConfig().mem0PreferencesOnly;
}

export function isMem0PreferencesOnly(): boolean {
  return getWorldModelConfig().mem0PreferencesOnly;
}

export function isMem0FactualWriteBlocked(): boolean {
  const config = getWorldModelConfig();
  return config.mem0PreferencesOnly || config.mode === 'canonical';
}

export function allowedMem0Types(): string[] {
  if (isMem0FactualWriteBlocked()) {
    return ['preference', 'avoidance', 'personality_trait', 'workflow_pattern'];
  }
  return ['fact', 'preference', 'avoidance', 'personality_trait', 'workflow_pattern', 'lesson'];
}

export function isMem0TypeAllowed(type: string): boolean {
  return allowedMem0Types().includes(type);
}
