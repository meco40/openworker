import {
  getNextSwarmPhase,
  getPhaseRounds,
  type SwarmPhase,
} from '@/modules/agent-room/swarmPhases';
import { countTurnsInCurrentPhase } from './text.utils';
import type { PhaseAdvanceResult } from '@/server/agent-room/types';

export { getPhaseRounds, getNextSwarmPhase };

export function getTurnsRequiredForPhase(phase: SwarmPhase, numAgents: number): number {
  return getPhaseRounds(phase) * Math.max(1, numAgents);
}

export function computeNextPhaseAfterTurn(params: {
  currentPhase: SwarmPhase;
  artifactAfterTurn: string;
  numAgents: number;
}): PhaseAdvanceResult {
  const turnsInPhase = countTurnsInCurrentPhase(params.artifactAfterTurn);
  const required = getTurnsRequiredForPhase(params.currentPhase, params.numAgents);

  if (turnsInPhase >= required) {
    const next = getNextSwarmPhase(params.currentPhase);
    if (!next) {
      return { nextPhase: params.currentPhase, phaseComplete: true, swarmComplete: true };
    }
    return { nextPhase: next, phaseComplete: true, swarmComplete: false };
  }
  return { nextPhase: params.currentPhase, phaseComplete: false, swarmComplete: false };
}

const DEFAULT_SIMPLE_SWARM_MAX_TURNS = 40;
const MIN_SIMPLE_SWARM_MAX_TURNS = 4;
const MAX_SIMPLE_SWARM_MAX_TURNS = 60;

export function getSimpleSwarmMaxTurns(): number {
  const envVal = process.env.AGENT_ROOM_SIMPLE_MAX_TURNS ?? process.env.AGENT_ROOM_MAX_TURNS;
  if (!envVal) return DEFAULT_SIMPLE_SWARM_MAX_TURNS;
  const raw = Number(envVal);
  if (!Number.isFinite(raw)) return DEFAULT_SIMPLE_SWARM_MAX_TURNS;
  return Math.max(
    MIN_SIMPLE_SWARM_MAX_TURNS,
    Math.min(MAX_SIMPLE_SWARM_MAX_TURNS, Math.floor(raw)),
  );
}

export function shouldCompleteSwarmAfterTurnWithTurnCount(
  nextPhase: SwarmPhase,
  nextTurnCount: number,
  maxTurns = getSimpleSwarmMaxTurns(),
): boolean {
  const safeTurnCount = Number.isFinite(nextTurnCount) ? Math.max(0, Math.floor(nextTurnCount)) : 0;
  return safeTurnCount >= maxTurns;
}

export function shouldCompleteSwarmAfterTurn(nextPhase: SwarmPhase): boolean {
  return shouldCompleteSwarmAfterTurnWithTurnCount(nextPhase, 0);
}
