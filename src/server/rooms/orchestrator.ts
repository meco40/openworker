import type { RoomRepository } from './repository';
import type { GatewayMessage } from '../model-hub/Models/types';
import { broadcastToUser } from '../gateway/broadcast';
import { GatewayEvents } from '../gateway/events';
import { executeRoomTool } from './toolExecutor';
import { getPersonaRepository } from '../personas/personaRepository';
import { getSkillRepository } from '../skills/skillRepository';
import { mapSkillsToTools } from '../../../skills/definitions';
import type { Skill } from '../../../types';
import {
  buildGatewayHistoryMessages,
  buildPersonaNameMap,
  buildSystemPromptParts,
  resolveRoutableMembers,
  selectNextSpeaker,
  stripSpeakerPrefix,
} from './orchestratorUtils';

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
  private runInProgress = false;

  constructor(
    private readonly repository: RoomRepository,
    options: RoomOrchestratorOptions = {},
  ) {
    this.instanceId = options.instanceId || `room-orchestrator-${process.pid}`;
    this.leaseTtlMs = options.leaseTtlMs || 30_000;
    this.now = options.now || (() => new Date());
    this.staticActiveModelsByProfile = options.activeModelsByProfile;
  }

  private resolveLeaseExpiryIso(): string {
    return new Date(this.now().getTime() + this.leaseTtlMs).toISOString();
  }

  private canMarkRoomDegraded(roomId: string): boolean {
    const currentRoom = this.repository.getRoom(roomId);
    if (!currentRoom || currentRoom.runState === 'stopped') {
      return false;
    }
    const activeRun = this.repository.getActiveRoomRun(roomId);
    if (!activeRun) {
      return false;
    }
    return !activeRun.leaseOwner || activeRun.leaseOwner === this.instanceId;
  }

  private async resolveActiveModelsByProfile(
    roomProfileId: string,
  ): Promise<Record<string, string[]>> {
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
    if (this.runInProgress) {
      return {
        processedRooms: 0,
        createdMessages: 0,
      };
    }
    this.runInProgress = true;
    try {
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
          let dispatchAbortController: AbortController | null = null;
          let lostLease = false;
          const keepaliveIntervalMs = Math.max(25, Math.floor(this.leaseTtlMs / 3));
          const keepaliveTimer = setInterval(() => {
            if (lostLease) return;
            try {
              this.repository.heartbeatRoomLease(
                room.id,
                lease.id,
                this.instanceId,
                this.resolveLeaseExpiryIso(),
              );
            } catch {
              lostLease = true;
              dispatchAbortController?.abort();
            }
          }, keepaliveIntervalMs);
          keepaliveTimer.unref?.();

          try {
            const members = this.repository.listMembers(room.id);
            const activeModelsByProfile = await this.resolveActiveModelsByProfile(
              room.routingProfileId,
            );

            // ── Round-robin speaker selection ────────────────────────────
            // Find valid members (those with a resolvable model), then pick
            // the next one after the last persona who spoke.
            const { routableMembers, validMembers } = resolveRoutableMembers(
              this.repository,
              members,
              room.id,
              room.routingProfileId,
              activeModelsByProfile,
            );

            if (routableMembers.length === 0) {
              if (this.canMarkRoomDegraded(room.id)) {
                this.repository.closeActiveRoomRun(
                  room.id,
                  'degraded',
                  'No active model for room members.',
                );
                broadcastToUser(room.userId, GatewayEvents.ROOM_RUN_STATUS, {
                  roomId: room.id,
                  runState: 'degraded',
                  updatedAt: this.now().toISOString(),
                });
              }
              continue;
            }

            if (validMembers.length === 0) {
              continue;
            }

            // Determine who spoke last and pick the next persona in rotation
            const recentMessagesForRotation = this.repository.listMessages(room.id, 5);
            const lastPersonaMessage = [...recentMessagesForRotation]
              .reverse()
              .find((m) => m.speakerType === 'persona' && m.speakerPersonaId);
            const lastSpeakerId = lastPersonaMessage?.speakerPersonaId;

            const selected = selectNextSpeaker(validMembers, lastSpeakerId || null);
            if (!selected) {
              continue;
            }

            const selectedRuntime = this.repository.getMemberRuntime(room.id, selected.personaId);
            if (selectedRuntime?.status === 'paused') {
              continue;
            }

            processedRooms += 1;
            const busyState = this.repository.upsertMemberRuntime({
              roomId: room.id,
              personaId: selected.personaId,
              status: 'busy',
              busyReason: `Thinking with ${selected.model}…`,
              currentTask: 'room_cycle',
              lastModel: selected.model,
              lastProfileId: selected.profileId,
            });
            broadcastToUser(room.userId, GatewayEvents.ROOM_MEMBER_STATUS, {
              roomId: room.id,
              personaId: selected.personaId,
              status: 'busy',
              reason: busyState.busyReason,
              updatedAt: busyState.updatedAt,
            });

            const existingSession = this.repository.getPersonaSession(room.id, selected.personaId);
            let session = this.repository.upsertPersonaSession(room.id, selected.personaId, {
              providerId: selected.profileId,
              model: selected.model,
              sessionId: existingSession?.sessionId || `room-${room.id}-${selected.personaId}`,
              lastSeenRoomSeq: existingSession?.lastSeenRoomSeq ?? 0,
            });

            // ── Build messages for AI dispatch ──────────────────────────

            // 1. System instruction from persona files + persona identity
            const personaRepo = getPersonaRepository();
            const systemInstruction = personaRepo.getPersonaSystemInstruction(selected.personaId);
            const persona = personaRepo.getPersona(selected.personaId);
            let clawHubPromptBlock = '';
            try {
              const { getClawHubService } = await import('../clawhub/clawhubService');
              clawHubPromptBlock = await getClawHubService().getPromptBlock();
            } catch {
              clawHubPromptBlock = '';
            }

            const systemParts = buildSystemPromptParts({
              systemInstruction,
              persona: persona ? { name: persona.name, vibe: persona.vibe } : null,
              roomDescription: room.description ?? null,
            });
            if (clawHubPromptBlock.trim()) {
              systemParts.push(clawHubPromptBlock.trim());
            }

            // 2. Context summary (if available)
            const previousContext = this.repository.getPersonaContext(room.id, selected.personaId);

            // 3. Build persona-local thread (isolated per persona session)
            const personaNameMap = buildPersonaNameMap(members, (personaId) =>
              personaRepo.getPersona(personaId),
            );
            const systemPrompt = systemParts.join('\n\n');

            const existingThreadHead = this.repository.listPersonaThreadMessages(
              room.id,
              selected.personaId,
              1,
            );
            if (existingThreadHead.length === 0) {
              this.repository.appendPersonaThreadMessage({
                roomId: room.id,
                personaId: selected.personaId,
                role: 'system',
                content: systemPrompt,
              });
            }

            const unseenRoomMessages = this.repository.listMessagesAfterSeq(
              room.id,
              session.lastSeenRoomSeq,
              500,
            );
            if (unseenRoomMessages.length > 0) {
              const mapped = buildGatewayHistoryMessages(
                unseenRoomMessages,
                selected.personaId,
                personaNameMap,
              );
              for (const message of mapped) {
                // Own persona outputs are already persisted into the persona thread as assistant.
                if (message.role === 'assistant') continue;
                this.repository.appendPersonaThreadMessage({
                  roomId: room.id,
                  personaId: selected.personaId,
                  role: 'user',
                  content: message.content,
                });
              }

              const lastSeenRoomSeq = unseenRoomMessages.at(-1)?.seq ?? session.lastSeenRoomSeq;
              session = this.repository.upsertPersonaSession(room.id, selected.personaId, {
                providerId: session.providerId,
                model: session.model,
                sessionId: session.sessionId,
                lastSeenRoomSeq,
              });
            }

            const personaThreadMessages = this.repository.listPersonaThreadMessages(
              room.id,
              selected.personaId,
              600,
            );
            const gatewayMessages: GatewayMessage[] = personaThreadMessages.map((message) => ({
              role: message.role,
              content: message.content,
            }));

            // If the thread only has a system message, seed with context summary or room topic.
            if (gatewayMessages.length === 1 && gatewayMessages[0]?.role === 'system') {
              const seededContent = previousContext?.summary
                ? `Context summary:\n${previousContext.summary}`
                : room.description || 'Beginne die Diskussion.';
              this.repository.appendPersonaThreadMessage({
                roomId: room.id,
                personaId: selected.personaId,
                role: 'user',
                content: seededContent,
              });
              gatewayMessages.push({ role: 'user', content: seededContent });
            }

            // 4. Resolve installed skills for tool definitions
            let tools: unknown[] | undefined;
            try {
              const skillRepo = await getSkillRepository();
              const skillRows = skillRepo.listSkills();
              const skills: Skill[] = skillRows.map((row) => ({
                id: row.id,
                name: row.name,
                description: row.description,
                category: row.category,
                installed: row.installed,
                version: row.version,
                functionName: row.functionName,
                source: row.source,
                sourceUrl: row.sourceUrl ?? undefined,
              }));
              const mapped = mapSkillsToTools(skills, 'openai');
              if (mapped.length > 0) tools = mapped;
            } catch {
              // Skills unavailable — proceed without tools
            }

            // ── Dispatch to AI model via ModelHub ───────────────────────

            const { getModelHubService, getModelHubEncryptionKey } =
              await import('../model-hub/runtime');
            const hubService = getModelHubService();
            const encryptionKey = getModelHubEncryptionKey();

            let responseText = '';
            let lastToolUsed: string | null = null;
            let sessionProviderId = session.providerId;
            let sessionModel = session.model;
            const MAX_TOOL_ROUNDS = 3;
            dispatchAbortController = new AbortController();

            for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
              if (lostLease) {
                break;
              }

              // Check if member was interrupted
              const currentRuntime = this.repository.getMemberRuntime(room.id, selected.personaId);
              if (currentRuntime?.status === 'interrupting') {
                this.repository.upsertMemberRuntime({
                  roomId: room.id,
                  personaId: selected.personaId,
                  status: 'interrupted',
                  busyReason: 'Interrupted by user',
                  currentTask: null,
                  lastModel: selected.model,
                  lastProfileId: selected.profileId,
                  lastTool: lastToolUsed,
                });
                broadcastToUser(room.userId, GatewayEvents.ROOM_MEMBER_STATUS, {
                  roomId: room.id,
                  personaId: selected.personaId,
                  status: 'interrupted',
                  reason: 'Interrupted by user',
                  updatedAt: this.now().toISOString(),
                });
                break;
              }

              const aiResponse = await hubService.dispatchWithFallback(
                selected.profileId,
                encryptionKey,
                {
                  messages: gatewayMessages,
                  tools,
                  auditContext: {
                    kind: 'room',
                    conversationId: room.id,
                    taskId: session.sessionId,
                  },
                },
                { modelOverride: selected.model, signal: dispatchAbortController.signal },
              );

              if (!aiResponse.ok) {
                if (lostLease && (aiResponse.error || '').toLowerCase().includes('aborted')) {
                  break;
                }
                // Set error state
                this.repository.upsertMemberRuntime({
                  roomId: room.id,
                  personaId: selected.personaId,
                  status: 'error',
                  busyReason: aiResponse.error || 'AI dispatch failed',
                  currentTask: null,
                  lastModel: selected.model,
                  lastProfileId: selected.profileId,
                  lastTool: lastToolUsed,
                });
                broadcastToUser(room.userId, GatewayEvents.ROOM_MEMBER_STATUS, {
                  roomId: room.id,
                  personaId: selected.personaId,
                  status: 'error',
                  reason: aiResponse.error || 'AI dispatch failed',
                  updatedAt: this.now().toISOString(),
                });
                break;
              }

              sessionProviderId = aiResponse.provider || sessionProviderId;
              sessionModel = aiResponse.model || sessionModel;

              // Handle function calls
              if (
                aiResponse.functionCalls &&
                aiResponse.functionCalls.length > 0 &&
                round < MAX_TOOL_ROUNDS
              ) {
                const fc = aiResponse.functionCalls[0]!;
                lastToolUsed = fc.name;

                this.repository.upsertMemberRuntime({
                  roomId: room.id,
                  personaId: selected.personaId,
                  status: 'busy',
                  busyReason: `Using tool: ${fc.name}`,
                  currentTask: 'tool_call',
                  lastModel: selected.model,
                  lastProfileId: selected.profileId,
                  lastTool: fc.name,
                });
                broadcastToUser(room.userId, GatewayEvents.ROOM_MEMBER_STATUS, {
                  roomId: room.id,
                  personaId: selected.personaId,
                  status: 'busy',
                  reason: `Using tool: ${fc.name}`,
                  updatedAt: this.now().toISOString(),
                });

                const permissions = this.repository.getPersonaPermissions(selected.personaId);
                const toolResult = await executeRoomTool({
                  functionName: fc.name,
                  args: (fc.args as Record<string, unknown>) ?? {},
                  permissions,
                });

                // Append tool result to conversation for next round
                const toolCallContent = `[Tool call: ${fc.name}]`;
                const toolResultContent = toolResult.ok
                  ? `Tool "${fc.name}" result:\n${toolResult.output}`
                  : `Tool "${fc.name}" failed: ${toolResult.output}`;

                this.repository.appendPersonaThreadMessage({
                  roomId: room.id,
                  personaId: selected.personaId,
                  role: 'assistant',
                  content: toolCallContent,
                });
                this.repository.appendPersonaThreadMessage({
                  roomId: room.id,
                  personaId: selected.personaId,
                  role: 'user',
                  content: toolResultContent,
                });

                gatewayMessages.push({ role: 'assistant', content: toolCallContent });
                gatewayMessages.push({ role: 'user', content: toolResultContent });

                continue; // Go to next round
              }

              // No function calls — we have final text
              responseText = aiResponse.text;
              break;
            }

            // ── Persist response & reset state ──────────────────────────

            if (lostLease) {
              continue;
            }

            // Only persist if we got a response (not interrupted / errored out with break)
            const currentStatus = this.repository.getMemberRuntime(room.id, selected.personaId);
            if (
              currentStatus?.status === 'interrupted' ||
              currentStatus?.status === 'error' ||
              currentStatus?.status === 'paused'
            ) {
              // Already handled above — skip message persist
              this.repository.heartbeatRoomLease(
                room.id,
                lease.id,
                this.instanceId,
                this.resolveLeaseExpiryIso(),
              );
              continue;
            }

            if (responseText) {
              // Strip any [Name]: prefix the model may have echoed — speaker attribution
              // is already stored via speakerPersonaId, not inline text.
              responseText = stripSpeakerPrefix(responseText);

              this.repository.appendPersonaThreadMessage({
                roomId: room.id,
                personaId: selected.personaId,
                role: 'assistant',
                content: responseText,
              });

              const message = this.repository.appendMessage({
                roomId: room.id,
                speakerType: 'persona',
                speakerPersonaId: selected.personaId,
                content: responseText,
                metadata: {
                  source: 'room-orchestrator',
                  profileId: selected.profileId,
                  model: selected.model,
                  sessionId: session.sessionId,
                },
              });

              session = this.repository.upsertPersonaSession(room.id, selected.personaId, {
                providerId: sessionProviderId,
                model: sessionModel,
                sessionId: session.sessionId,
                lastSeenRoomSeq: message.seq,
              });

              this.repository.upsertPersonaContext(room.id, selected.personaId, {
                summary: previousContext
                  ? `${previousContext.summary}\n${message.content}`.slice(-1000)
                  : message.content,
                lastMessageSeq: message.seq,
              });

              broadcastToUser(room.userId, GatewayEvents.ROOM_MESSAGE, {
                id: message.id,
                roomId: room.id,
                seq: message.seq,
                speakerType: message.speakerType,
                speakerPersonaId: message.speakerPersonaId,
                content: message.content,
                createdAt: message.createdAt,
              });

              createdMessages += 1;
            }

            const idleState = this.repository.upsertMemberRuntime({
              roomId: room.id,
              personaId: selected.personaId,
              status: 'idle',
              busyReason: null,
              currentTask: null,
              lastModel: selected.model,
              lastProfileId: selected.profileId,
              lastTool: lastToolUsed,
            });
            broadcastToUser(room.userId, GatewayEvents.ROOM_MEMBER_STATUS, {
              roomId: room.id,
              personaId: selected.personaId,
              status: 'idle',
              reason: null,
              updatedAt: idleState.updatedAt,
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

            this.repository.heartbeatRoomLease(
              room.id,
              lease.id,
              this.instanceId,
              this.resolveLeaseExpiryIso(),
            );
          } finally {
            clearInterval(keepaliveTimer);
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Room cycle failed.';
          if (!this.canMarkRoomDegraded(room.id)) {
            continue;
          }
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
    } finally {
      this.runInProgress = false;
    }
  }
}
