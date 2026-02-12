import type { RoomRepository } from './repository';
import type { GatewayMessage } from '../model-hub/Models/types';
import { broadcastToUser } from '../gateway/broadcast';
import { GatewayEvents } from '../gateway/events';
import { resolveRoomRouting } from './service';
import { executeRoomTool } from './toolExecutor';
import { getPersonaRepository } from '../personas/personaRepository';
import { getSkillRepository } from '../skills/skillRepository';
import { mapSkillsToTools } from '../../../skills/definitions';
import type { Skill } from '../../../types';

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

  constructor(private readonly repository: RoomRepository, options: RoomOrchestratorOptions = {}) {
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

        const members = this.repository.listMembers(room.id);
        const activeModelsByProfile = await this.resolveActiveModelsByProfile(room.routingProfileId);

        // ── Round-robin speaker selection ────────────────────────────
        // Find valid members (those with a resolvable model), then pick
        // the next one after the last persona who spoke.
        const validMembers: { personaId: string; model: string; profileId: string }[] = [];
        for (const member of members) {
          const resolved = resolveRoomRouting({
            roomProfileId: room.routingProfileId,
            memberModelOverride: member.modelOverride,
            activeModelsByProfile,
          });
          if (resolved.model && resolved.profileId) {
            validMembers.push({
              personaId: member.personaId,
              model: resolved.model,
              profileId: resolved.profileId,
            });
          }
        }

        if (validMembers.length === 0) {
          if (this.canMarkRoomDegraded(room.id)) {
            this.repository.closeActiveRoomRun(room.id, 'degraded', 'No active model for room members.');
            broadcastToUser(room.userId, GatewayEvents.ROOM_RUN_STATUS, {
              roomId: room.id,
              runState: 'degraded',
              updatedAt: this.now().toISOString(),
            });
          }
          continue;
        }

        // Determine who spoke last and pick the next persona in rotation
        const recentMessagesForRotation = this.repository.listMessages(room.id, 5);
        const lastPersonaMessage = [...recentMessagesForRotation]
          .reverse()
          .find((m) => m.speakerType === 'persona' && m.speakerPersonaId);
        const lastSpeakerId = lastPersonaMessage?.speakerPersonaId;

        let selected: { personaId: string; model: string; profileId: string };
        if (!lastSpeakerId) {
          // No persona has spoken yet — pick the first valid member
          selected = validMembers[0]!;
        } else {
          const lastIndex = validMembers.findIndex((m) => m.personaId === lastSpeakerId);
          const nextIndex = (lastIndex + 1) % validMembers.length;
          selected = validMembers[nextIndex]!;
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
        const session = this.repository.upsertPersonaSession(room.id, selected.personaId, {
          providerId: selected.profileId,
          model: selected.model,
          sessionId: existingSession?.sessionId || `room-${room.id}-${selected.personaId}`,
        });

        // ── Build messages for AI dispatch ──────────────────────────

        // 1. System instruction from persona files + persona identity
        const personaRepo = getPersonaRepository();
        const systemInstruction = personaRepo.getPersonaSystemInstruction(selected.personaId);
        const persona = personaRepo.getPersona(selected.personaId);

        // Build system prompt parts
        const systemParts: string[] = [];

        // SOUL.md / AGENTS.md / USER.md first
        if (systemInstruction) {
          systemParts.push(systemInstruction);
        } else if (persona) {
          // Fallback when no personality files exist
          const fallback = [`Dein Name ist "${persona.name}".`];
          if (persona.vibe) fallback.push(`Vibe: ${persona.vibe}`);
          systemParts.push(fallback.join(' '));
        }

        // Room context
        if (room.description) {
          systemParts.push(`---\nKontext: ${room.description}\n---`);
        }

        // Group behavior
        systemParts.push('Du bist in einer Gruppendiskussion. Antworte nur als du selbst.');

        // 2. Context summary (if available)
        const previousContext = this.repository.getPersonaContext(room.id, selected.personaId);

        // 3. Build gateway messages — system message FIRST, then conversation history
        const recentMessages = this.repository.listMessages(room.id, 20);

        // Build a persona ID → name map for message attribution (no emoji)
        const personaNameMap = new Map<string, string>();
        for (const m of members) {
          const p = personaRepo.getPersona(m.personaId);
          personaNameMap.set(m.personaId, p?.name || m.personaId);
        }

        const gatewayMessages: GatewayMessage[] = [];

        // Prepend system message (same pattern as normal WebUI chat)
        gatewayMessages.push({ role: 'system', content: systemParts.join('\n\n') });

        // Add conversation history
        for (const msg of recentMessages) {
          const isOwnMessage = msg.speakerType === 'persona' && msg.speakerPersonaId === selected.personaId;
          let content = msg.content;
          if (msg.speakerType === 'persona' && msg.speakerPersonaId && !isOwnMessage) {
            // Only prefix OTHER personas' messages — own messages go as plain assistant role
            const name = personaNameMap.get(msg.speakerPersonaId) || msg.speakerPersonaId;
            content = `[${name}]: ${msg.content}`;
          } else if (msg.speakerType === 'user') {
            content = `[User]: ${msg.content}`;
          } else if (msg.speakerType === 'system') {
            content = `[System]: ${msg.content}`;
          }
          gatewayMessages.push({
            role: isOwnMessage ? 'assistant' as const : 'user' as const,
            content,
          });
        }

        // If no messages yet, seed with context summary or task-aware prompt
        if (gatewayMessages.length === 0) {
          if (previousContext?.summary) {
            gatewayMessages.push({ role: 'user', content: `Context summary:\n${previousContext.summary}` });
          } else {
            // Seed prompt: only the topic/task, no participant list
            const seedParts: string[] = [];
            if (room.description) {
              seedParts.push(room.description);
            } else {
              seedParts.push('Beginne die Diskussion.');
            }
            gatewayMessages.push({ role: 'user', content: seedParts.join('\n') });
          }
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

        const { getModelHubService, getModelHubEncryptionKey } = await import('../model-hub/runtime');
        const hubService = getModelHubService();
        const encryptionKey = getModelHubEncryptionKey();

        let responseText = '';
        let lastToolUsed: string | null = null;
        const MAX_TOOL_ROUNDS = 3;
        const dispatchAbortController = new AbortController();
        let lostLease = false;
        const keepaliveIntervalMs = Math.max(25, Math.floor(this.leaseTtlMs / 3));
        const keepaliveTimer = setInterval(() => {
          if (lostLease) return;
          try {
            this.repository.heartbeatRoomLease(room.id, lease.id, this.instanceId, this.resolveLeaseExpiryIso());
          } catch {
            lostLease = true;
            dispatchAbortController.abort();
          }
        }, keepaliveIntervalMs);
        keepaliveTimer.unref?.();

        try {
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

            // Handle function calls
            if (aiResponse.functionCalls && aiResponse.functionCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
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
              gatewayMessages.push({ role: 'assistant', content: `[Tool call: ${fc.name}]` });
              gatewayMessages.push({
                role: 'user',
                content: toolResult.ok
                  ? `Tool "${fc.name}" result:\n${toolResult.output}`
                  : `Tool "${fc.name}" failed: ${toolResult.output}`,
              });

              continue; // Go to next round
            }

            // No function calls — we have final text
            responseText = aiResponse.text;
            break;
          }
        } finally {
          clearInterval(keepaliveTimer);
        }

        // ── Persist response & reset state ──────────────────────────

        if (lostLease) {
          continue;
        }

        // Only persist if we got a response (not interrupted / errored out with break)
        const currentStatus = this.repository.getMemberRuntime(room.id, selected.personaId);
        if (currentStatus?.status === 'interrupted' || currentStatus?.status === 'error') {
          // Already handled above — skip message persist
          this.repository.heartbeatRoomLease(room.id, lease.id, this.instanceId, this.resolveLeaseExpiryIso());
          continue;
        }

        if (responseText) {
          // Strip any [Name]: prefix the model may have echoed — speaker attribution
          // is already stored via speakerPersonaId, not inline text.
          responseText = responseText.replace(/^\[[^\]]{1,30}\]:\s*/g, '').trim();

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

        this.repository.heartbeatRoomLease(room.id, lease.id, this.instanceId, this.resolveLeaseExpiryIso());
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
