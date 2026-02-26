import { getMessageRepository } from '@/server/channels/messages/runtime';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { GatewayEvents } from '@/server/gateway/events';
import type { AgentRoomSwarmRecord } from '@/server/channels/messages/repository/types';

import { dispatchNextTurn } from '@/server/agent-room/services/turnDispatch.service';
import { checkTurnCompletion } from '@/server/agent-room/services/turnCompletion.service';

const processing = new Set<string>();
const retryCounters = new Map<string, number>();
const MAX_RETRIES = 3;

export async function runOrchestratorOnce(): Promise<void> {
  const repo = getMessageRepository();
  if (!repo.listRunningSwarms) return;

  const runningSwarms = repo.listRunningSwarms(50);

  for (const swarm of runningSwarms) {
    if (processing.has(swarm.id)) continue;
    processing.add(swarm.id);
    try {
      await processSwarmTick(swarm);
      // Reset retry counter on success
      retryCounters.delete(swarm.id);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err || '');
      const isRateLimit = /429|too many requests|rate.limit|resource.exhausted/i.test(errMsg);

      if (isRateLimit) {
        console.warn(
          `[swarm-orchestrator] rate limited for swarm ${swarm.id}, will retry next tick`,
        );
      } else {
        const currentRetries = (retryCounters.get(swarm.id) ?? 0) + 1;
        retryCounters.set(swarm.id, currentRetries);

        if (currentRetries < MAX_RETRIES) {
          console.warn(
            `[swarm-orchestrator] transient error for swarm ${swarm.id} (attempt ${currentRetries}/${MAX_RETRIES}), will retry next tick:`,
            errMsg,
          );
        } else {
          console.error(
            `[swarm-orchestrator] tick failed for swarm ${swarm.id} after ${MAX_RETRIES} attempts:`,
            err,
          );
          retryCounters.delete(swarm.id);
          try {
            const r = getMessageRepository();
            const errorSwarm = r.updateAgentRoomSwarm?.(swarm.id, swarm.userId, {
              status: 'error',
              holdFlag: true,
            });
            broadcastToUser(
              swarm.userId,
              GatewayEvents.AGENT_ROOM_SWARM,
              {
                swarmId: swarm.id,
                status: 'updated',
                swarm: errorSwarm ?? undefined,
                updatedAt: new Date().toISOString(),
              },
              { protocol: 'v2' },
            );
          } catch {
            // best effort
          }
        }
      }
    } finally {
      processing.delete(swarm.id);
    }
  }
}

async function processSwarmTick(swarm: AgentRoomSwarmRecord): Promise<void> {
  const repo = getMessageRepository();
  if (!repo.updateAgentRoomSwarm || !repo.getAgentRoomSwarm) return;

  const fresh = repo.getAgentRoomSwarm(swarm.id, swarm.userId);
  if (!fresh || fresh.status !== 'running') return;

  if (!fresh.currentDeployCommandId) {
    await dispatchNextTurn(fresh);
    return;
  }

  await checkTurnCompletion(fresh);
}
