import type { SpeakerSelectionParams } from '@/server/agent-room/types';

/**
 * Role-to-phase affinity weights.
 * Higher weight = higher priority for that phase.
 * Roles not listed get a weight of 1 (neutral).
 */
const ROLE_PHASE_WEIGHTS: Record<string, Record<string, number>> = {
  analysis: { analyst: 3, researcher: 3, architect: 2, lead: 1 },
  research: { researcher: 4, analyst: 2, investigator: 3, lead: 1 },
  ideation: { creative: 3, innovator: 3, designer: 2, lead: 1 },
  critique: { critic: 3, reviewer: 3, 'quality assurance': 2, tester: 2, lead: 1 },
  best_case: { architect: 3, strategist: 2, lead: 2, optimizer: 2 },
  result: { lead: 3, orchestrator: 3, writer: 2, synthesizer: 2 },
};

/**
 * Builds a weighted speaker order for the current phase.
 * Agents with higher role affinity for the current phase speak more often.
 * Falls back to simple round-robin when no phase is supplied.
 */
function buildWeightedOrder(
  orderedPersonaIds: string[],
  units: Array<{ personaId: string; role: string }>,
  currentPhase: string | undefined,
): string[] {
  if (!currentPhase || !ROLE_PHASE_WEIGHTS[currentPhase]) {
    return orderedPersonaIds;
  }

  const phaseWeights = ROLE_PHASE_WEIGHTS[currentPhase];
  const roleByPersona = new Map<string, string>();
  for (const unit of units) {
    const pid = String(unit.personaId || '').trim();
    if (pid)
      roleByPersona.set(
        pid,
        String(unit.role || '')
          .toLowerCase()
          .trim(),
      );
  }

  // Build expanded array: each persona appears `weight` times in sequence
  const expanded: string[] = [];
  for (const pid of orderedPersonaIds) {
    const role = roleByPersona.get(pid) ?? '';
    const weight = phaseWeights[role] ?? 1;
    for (let i = 0; i < weight; i++) {
      expanded.push(pid);
    }
  }

  return expanded.length > 0 ? expanded : orderedPersonaIds;
}

export function chooseNextSpeakerPersonaId(params: SpeakerSelectionParams): string {
  const turnCount = Math.max(0, Math.floor(params.turnCount || 0));
  const leadPersonaId = String(params.leadPersonaId || '').trim();
  const orderedPersonaIds: string[] = [];
  const seen = new Set<string>();

  if (leadPersonaId) {
    orderedPersonaIds.push(leadPersonaId);
    seen.add(leadPersonaId);
  }

  for (const unit of params.units) {
    const personaId = String(unit.personaId || '').trim();
    if (!personaId || seen.has(personaId)) continue;
    orderedPersonaIds.push(personaId);
    seen.add(personaId);
  }

  if (orderedPersonaIds.length === 0) return '';

  const weighted = buildWeightedOrder(orderedPersonaIds, params.units, params.currentPhase);
  return weighted[turnCount % weighted.length] || orderedPersonaIds[0];
}
