import type { RoomRepository } from './repository';
import { broadcastToUser } from '../gateway/broadcast';
import { GatewayEvents } from '../gateway/events';
import { resolveRoomRouting } from './service';
import { executeRoomTool } from './toolExecutor';

export interface RoomOrchestratorRunResult {
  processedRooms: number;
  createdMessages: number;
}

export interface RoomOrchestratorOptions {
  instanceId?: string;
  leaseTtlMs?: number;
  activeModelsByProfile?: Record<string, string[]>;
  now?: () => Date;
}

export class RoomOrchestrator {
  private readonly instanceId: string;
  private readonly leaseTtlMs: number;
  private readonly now: () => Date;
  private readonly staticActiveModelsByProfile?: Record<string, string[]>;

  constructor(private readonly repository: RoomRepository, options: RoomOrchestratorOptions = {}) {
    this.instanceId = options.instanceId || `room-orchestrator-${process.pid}`;
    this.leaseTtlMs = options.leaseTtlMs || 30_000;
    this.now = options.now || (() => new Date());
    this.staticActiveModelsByProfile = options.activeModelsByProfile;
  }

  private resolveLeaseExpiryIso(): string {
    return new Date(this.now().getTime() + this.leaseTtlMs).toISOString();
  }

  private async resolveActiveModelsByProfile(roomProfileId: string): Promise<Record<string, string[]>> {
    if (this.staticActiveModelsByProfile) {
      return this.staticActiveModelsByProfile;
    }

    try {
      const { getModelHubService } = await import('../model-hub/runtime');
      const service = getModelHubService();
      const roomProfileModels = service
        .listPipeline(roomProfileId)
        .filter((entry) => entry.status === 'active')
        .map((entry) => entry.modelName);
      const defaultModels =
        roomProfileId === 'p1'
          ? roomProfileModels
          : service
              .listPipeline('p1')
              .filter((entry) => entry.status === 'active')
              .map((entry) => entry.modelName);
      return {
        [roomProfileId]: roomProfileModels,
        p1: defaultModels,
      };
    } catch {
      return {};
    }
  }

  async runOnce(): Promise<RoomOrchestratorRunResult> {
    const runningRooms = this.repository.listRunningRooms();
    let createdMessages = 0;
    let processedRooms = 0;

    for (const room of runningRooms) {
      try {
        const leaseExpiry = this.resolveLeaseExpiryIso();
        const lease = this.repository.acquireRoomLease(room.id, this.instanceId, leaseExpiry);
        if (lease.leaseOwner !== this.instanceId) {
          continue;
        }

        this.repository.heartbeatRoomLease(room.id, lease.id, this.instanceId, leaseExpiry);

        const members = this.repository.listMembers(room.id);
        const activeModelsByProfile = await this.resolveActiveModelsByProfile(room.routingProfileId);

        let selected:
          | {
              personaId: string;
              model: string;
              profileId: string;
            }
          | null = null;

        for (const member of members) {
          const resolved = resolveRoomRouting({
            roomProfileId: room.routingProfileId,
            memberModelOverride: member.modelOverride,
            activeModelsByProfile,
          });
          if (!resolved.model || !resolved.profileId) {
            continue;
          }
          selected = {
            personaId: member.personaId,
            model: resolved.model,
            profileId: resolved.profileId,
          };
          break;
        }

        if (!selected) {
          this.repository.closeActiveRoomRun(room.id, 'degraded', 'No active model for room members.');
          broadcastToUser(room.userId, GatewayEvents.ROOM_RUN_STATUS, {
            roomId: room.id,
            runState: 'degraded',
            updatedAt: this.now().toISOString(),
          });
          continue;
        }

        processedRooms += 1;
        const busyState = this.repository.upsertMemberRuntime({
          roomId: room.id,
          personaId: selected.personaId,
          status: 'busy',
          busyReason: `Busy: researching with ${selected.model}`,
          currentTask: 'room_cycle',
          lastModel: selected.model,
          lastProfileId: selected.profileId,
          lastTool: 'search',
        });
        broadcastToUser(room.userId, GatewayEvents.ROOM_MEMBER_STATUS, {
          roomId: room.id,
          personaId: selected.personaId,
          status: 'busy',
          reason: busyState.busyReason,
          updatedAt: busyState.updatedAt,
        });

        const existingSession = this.repository.getPersonaSession(room.id, selected.personaId);
        const session = this.repository.upsertPersonaSession(room.id, selected.personaId, {
          providerId: selected.profileId,
          model: selected.model,
          sessionId: existingSession?.sessionId || `room-${room.id}-${selected.personaId}`,
        });

        const permissions = this.repository.getPersonaPermissions(selected.personaId);
        const toolResult = await executeRoomTool({
          toolName: 'search',
          permissions,
        });

        const message = this.repository.appendMessage({
          roomId: room.id,
          speakerType: 'persona',
          speakerPersonaId: selected.personaId,
          content: `${toolResult.output} [model=${selected.model}]`,
          metadata: {
            source: 'room-orchestrator',
            profileId: selected.profileId,
            model: selected.model,
            sessionId: session.sessionId,
          },
        });

        const previousContext = this.repository.getPersonaContext(room.id, selected.personaId);
        this.repository.upsertPersonaContext(room.id, selected.personaId, {
          summary: previousContext
            ? `${previousContext.summary}\n${message.content}`.slice(-1000)
            : message.content,
          lastMessageSeq: message.seq,
        });

        const idleState = this.repository.upsertMemberRuntime({
          roomId: room.id,
          personaId: selected.personaId,
          status: 'idle',
          busyReason: null,
          currentTask: null,
          lastModel: selected.model,
          lastProfileId: selected.profileId,
          lastTool: 'search',
        });
        broadcastToUser(room.userId, GatewayEvents.ROOM_MEMBER_STATUS, {
          roomId: room.id,
          personaId: selected.personaId,
          status: 'idle',
          reason: null,
          updatedAt: idleState.updatedAt,
        });

        broadcastToUser(room.userId, GatewayEvents.ROOM_MESSAGE, {
          roomId: room.id,
          seq: message.seq,
          speakerType: message.speakerType,
          speakerPersonaId: message.speakerPersonaId,
          content: message.content,
          createdAt: message.createdAt,
        });

        broadcastToUser(room.userId, GatewayEvents.ROOM_RUN_STATUS, {
          roomId: room.id,
          runState: 'running',
          updatedAt: this.now().toISOString(),
        });
        broadcastToUser(room.userId, GatewayEvents.ROOM_METRICS, {
          roomId: room.id,
          messageCount: this.repository.countMessages(room.id),
          memberCount: members.length,
          generatedAt: this.now().toISOString(),
        });

        this.repository.heartbeatRoomLease(room.id, lease.id, this.instanceId, this.resolveLeaseExpiryIso());
        createdMessages += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Room cycle failed.';
        this.repository.closeActiveRoomRun(room.id, 'degraded', reason);
        broadcastToUser(room.userId, GatewayEvents.ROOM_RUN_STATUS, {
          roomId: room.id,
          runState: 'degraded',
          updatedAt: this.now().toISOString(),
        });
      }
    }

    return {
      processedRooms,
      createdMessages,
    };
  }
}
