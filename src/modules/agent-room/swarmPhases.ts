/**
 * Re-export from the canonical shared module.
 * Frontend code may continue importing from here.
 * Server code MUST import from `@/shared/domain/swarmPhases` instead.
 */
export {
  SWARM_PHASES,
  type SwarmPhase,
  type ResolvedSwarmUnit,
  getPhaseRounds,
  isSwarmPhase,
  getSwarmPhaseLabel,
  getNextSwarmPhase,
  buildPhasePrompt,
  buildAgentTurnPrompt,
} from '@/shared/domain/swarmPhases';
