import type { SwarmPhase } from '@/shared/domain/swarmPhases';

/**
 * Phase-related utilities for swarm phase management.
 */

export function buildPhaseIdempotencyKey(swarmId: string, phase: SwarmPhase): string {
  return `${swarmId}:${phase}`;
}

export function getPhaseCommandMethod(
  phase: SwarmPhase,
): 'agent.v2.session.input' | 'agent.v2.session.follow_up' {
  return phase === 'analysis' ? 'agent.v2.session.input' : 'agent.v2.session.follow_up';
}
