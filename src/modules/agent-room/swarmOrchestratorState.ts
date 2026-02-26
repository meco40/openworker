import type { SwarmFriction, UpdateSwarmInput } from '@/modules/agent-room/swarmTypes';

export interface SwarmOrchestratorState {
  artifact: string;
  artifactHistory: string[];
  friction: SwarmFriction;
}

export function buildSwarmProjectionPatch(
  state: SwarmOrchestratorState,
): Pick<UpdateSwarmInput, 'artifact' | 'artifactHistory' | 'friction' | 'holdFlag'> {
  return {
    artifact: state.artifact,
    artifactHistory: state.artifactHistory,
    friction: state.friction,
    holdFlag: Boolean(state.friction.hold),
  };
}
