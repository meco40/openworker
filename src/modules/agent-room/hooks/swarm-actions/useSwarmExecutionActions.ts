import { useCallback, useState } from 'react';
import type { SwarmRecord } from '@/modules/agent-room/swarmTypes';
import type { AgentV2EventEnvelope } from '@/server/agent-v2/types';
import {
  applySwarmTerminalEvent,
  getNextPhaseOrNull,
  normalizeSingleSwarm,
  replaySessionTail,
  type AgentRoomDeployState,
  type SwarmActionCommonInput,
} from './shared';

export function useSwarmExecutionActions(input: SwarmActionCommonInput) {
  const { clientRef, sessionToSwarmRef, setError, swarms, swarmsRef, syncSwarm, updateSwarmLocal } =
    input;

  const [deployState, setDeployState] = useState<AgentRoomDeployState>('idle');

  const deploySwarm = useCallback(
    async (swarmId: string): Promise<void> => {
      const client = clientRef.current;
      if (!client) return;
      const target = swarmsRef.current.find((item) => item.id === swarmId);
      if (!target) return;
      setDeployState('deploying');
      setError(null);
      try {
        const result = (await client.request('agent.v2.swarm.deploy', {
          id: swarmId,
        })) as { swarm?: unknown };
        if (result?.swarm) {
          const parsed = normalizeSingleSwarm(result);
          if (parsed) {
            updateSwarmLocal(swarmId, { status: 'running' });
            if (parsed.sessionId) {
              sessionToSwarmRef.current.set(parsed.sessionId, swarmId);
            }
          }
        }
      } catch (deployError) {
        setError(deployError instanceof Error ? deployError.message : 'Deploy failed.');
      } finally {
        setDeployState('idle');
      }
    },
    [clientRef, sessionToSwarmRef, setError, swarmsRef, updateSwarmLocal],
  );

  const pauseSwarm = useCallback(
    async (swarmId: string): Promise<void> => {
      const swarm = swarms.find((item) => item.id === swarmId);
      if (!swarm) return;
      try {
        if (swarm.status === 'hold') {
          await deploySwarm(swarmId);
          return;
        }
        if (swarm.status !== 'running') return;
        await syncSwarm(swarmId, { status: 'hold', holdFlag: true, currentDeployCommandId: null });
      } catch (pauseError) {
        setError(pauseError instanceof Error ? pauseError.message : 'Failed to pause swarm.');
      }
    },
    [deploySwarm, setError, swarms, syncSwarm],
  );

  const abortSwarm = useCallback(
    async (swarmId: string): Promise<void> => {
      const client = clientRef.current;
      if (!client) return;
      const swarm = swarms.find((item) => item.id === swarmId);
      if (!swarm) return;
      try {
        if (swarm.sessionId) {
          await client.request('agent.v2.session.abort', {
            sessionId: swarm.sessionId,
            reason: 'Abort requested from Agent Room.',
            idempotencyKey: `abort:${swarm.id}`,
          });
        }
        await syncSwarm(swarmId, { status: 'aborted', holdFlag: true });
      } catch (abortError) {
        setError(abortError instanceof Error ? abortError.message : 'Failed to abort swarm.');
      }
    },
    [clientRef, setError, swarms, syncSwarm],
  );

  const forceNextPhase = useCallback(
    async (swarmId: string): Promise<void> => {
      const swarm = swarms.find((item) => item.id === swarmId);
      if (!swarm) return;
      const nextPhase = getNextPhaseOrNull(swarm);
      if (!nextPhase) return;
      try {
        await syncSwarm(swarmId, { currentPhase: nextPhase, status: 'running' });
      } catch (phaseError) {
        setError(phaseError instanceof Error ? phaseError.message : 'Failed to advance phase.');
      }
    },
    [setError, swarms, syncSwarm],
  );

  const forceComplete = useCallback(
    async (swarmId: string): Promise<void> => {
      try {
        await syncSwarm(swarmId, {
          status: 'completed',
          currentPhase: 'result',
          consensusScore: 100,
          holdFlag: false,
        });
      } catch (completeError) {
        setError(
          completeError instanceof Error ? completeError.message : 'Failed to complete swarm.',
        );
      }
    },
    [setError, syncSwarm],
  );

  const rehydrateSwarm = useCallback(
    async (swarm: SwarmRecord): Promise<void> => {
      const client = clientRef.current;
      if (!client || !swarm.sessionId) return;
      try {
        const nextSeq = await replaySessionTail(client, swarm);
        if (nextSeq > swarm.lastSeq) {
          await syncSwarm(swarm.id, { lastSeq: nextSeq });
        }
      } catch (rehydrateError) {
        setError(
          rehydrateError instanceof Error
            ? rehydrateError.message
            : 'Failed to recover swarm session state.',
        );
      }
    },
    [clientRef, setError, syncSwarm],
  );

  const handleAgentEvent = useCallback(
    (event: AgentV2EventEnvelope) => {
      applySwarmTerminalEvent(event, updateSwarmLocal, sessionToSwarmRef);
    },
    [sessionToSwarmRef, updateSwarmLocal],
  );

  return {
    deployState,
    deploySwarm,
    pauseSwarm,
    abortSwarm,
    forceNextPhase,
    forceComplete,
    rehydrateSwarm,
    handleAgentEvent,
  };
}
