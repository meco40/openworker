import { getWorldModelConfig } from '@/server/world-model/config';

/**
 * Phase 6 (Mem0 reduzieren): Kontrollierte Reduktions-Policy.
 * Wenn `WORLD_MODEL_MEM0_PREFERENCES_ONLY=true`, wird Mem0 nicht mehr als
 * primaere faktische Wahrheit behandelt; das Weltmodell uebernimmt das und
 * Mem0 bleibt fuer persoenliche Praeferenzen/Stil.
 */
export function isMem0PrimaryMemory(): boolean {
  return !getWorldModelConfig().mem0PreferencesOnly;
}

export function isMem0PreferencesOnly(): boolean {
  return getWorldModelConfig().mem0PreferencesOnly;
}
