import type { SwarmPhase } from '@/shared/domain/swarmPhases';
import { getSwarmPhaseLabel } from '@/shared/domain/swarmPhases';

const ARTIFACT_MAX_CHARS = 20_000;
const ARTIFACT_HISTORY_LIMIT = 24;

export function clampArtifact(text: string): string {
  const value = String(text || '');
  if (value.length <= ARTIFACT_MAX_CHARS) return value;
  return value.slice(value.length - ARTIFACT_MAX_CHARS);
}

export function pushArtifactSnapshot(history: string[], artifact: string): string[] {
  const normalized = String(artifact || '').trim();
  if (!normalized) return history;
  if (history[history.length - 1] === normalized) return history;
  const next = [...history, normalized];
  if (next.length <= ARTIFACT_HISTORY_LIMIT) return next;
  return next.slice(next.length - ARTIFACT_HISTORY_LIMIT);
}

export function buildArtifactWithNewTurn(
  existingArtifact: string,
  turnLine: string,
  currentPhase: SwarmPhase,
  phaseComplete: boolean,
  nextPhase: SwarmPhase,
): string {
  let newArtifactContent: string;

  if (!existingArtifact || !existingArtifact.trim()) {
    // First turn — include initial phase marker
    const phaseLabel = getSwarmPhaseLabel(currentPhase);
    newArtifactContent = `--- ${phaseLabel} ---\n\n${turnLine}`;
  } else {
    // Append turn to current phase
    newArtifactContent = `${existingArtifact}\n\n${turnLine}`;
  }

  // If the phase just completed (but swarm isn't done), insert the NEXT phase marker
  if (phaseComplete) {
    const nextPhaseLabel = getSwarmPhaseLabel(nextPhase);
    newArtifactContent = `${newArtifactContent}\n\n--- ${nextPhaseLabel} ---`;
  }

  return clampArtifact(newArtifactContent);
}

export function clampConsensusScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
