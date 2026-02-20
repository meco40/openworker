import type { RoomRepository } from '@/server/rooms/repository';
import type {
  Room,
  RoomIntervention,
  RoomMember,
  RoomMemberRuntime,
  RoomMessage,
  RoomRunState,
} from '@/server/rooms/types';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { GatewayEvents } from '@/server/gateway/events';
import { getPersonaRepository } from '@/server/personas/personaRepository';

export interface ResolveRoomRoutingInput {
  roomProfileId: string;
  memberModelOverride: string | null;
  activeModelsByProfile: Record<string, string[]>;
}

export interface ResolveRoomRoutingResult {
  profileId: string | null;
  model: string | null;
  fallbackUsed: boolean;
}

export function resolveRoomRouting(input: ResolveRoomRoutingInput): ResolveRoomRoutingResult {
  const roomModels = input.activeModelsByProfile[input.roomProfileId] || [];
  const defaultModels = input.activeModelsByProfile.p1 || [];

  if (input.memberModelOverride && roomModels.includes(input.memberModelOverride)) {
    return {
      profileId: input.roomProfileId,
      model: input.memberModelOverride,
      fallbackUsed: false,
    };
  }

  if (roomModels.length > 0) {
    return {
      profileId: input.roomProfileId,
      model: roomModels[0],
      fallbackUsed: Boolean(input.memberModelOverride),
    };
  }

  if (defaultModels.length > 0) {
    return {
      profileId: 'p1',
      model: defaultModels[0],
      fallbackUsed: true,
    };
  }

  return {
    profileId: null,
    model: null,
    fallbackUsed: true,
  };
}

function assertRoomOwner(room: Room | null, userId: string): Room {
  if (!room || room.userId !== userId) {
    throw new Error('Room not found');
  }
  return room;
}

export class RoomService {
  constructor(private readonly repository: RoomRepository) {}

  createRoom(
    userId: string,
    input: {
      name: string;
      description?: string | null;
      goalMode: Room['goalMode'];
      routingProfileId: string;
    },
  ): Room {
    const room = this.repository.createRoom({
      userId,
      name: input.name,
      description: input.description ?? null,
      goalMode: input.goalMode,
      routingProfileId: input.routingProfileId || 'p1',
    });
    broadcastToUser(userId, GatewayEvents.ROOM_RUN_STATUS, {
      roomId: room.id,
      runState: room.runState,
      updatedAt: room.updatedAt,
    });
    return room;
  }

  listRooms(userId: string): Room[] {
    return this.repository.listRooms(userId);
  }

  getRoom(userId: string, roomId: string): Room {
    return assertRoomOwner(this.repository.getRoom(roomId), userId);
  }

  deleteRoom(userId: string, roomId: string): boolean {
    const room = assertRoomOwner(this.repository.getRoom(roomId), userId);
    // Stop the room if it's still running before deleting
    if (room.runState === 'running' || room.runState === 'degraded') {
      this.repository.closeActiveRoomRun(roomId, 'stopped', null);
    }
    return this.repository.deleteRoom(roomId);
  }

  addMember(
    userId: string,
    roomId: string,
    input: {
      personaId: string;
      roleLabel: string;
      turnPriority?: number;
      modelOverride?: string | null;
    },
  ): RoomMember {
    assertRoomOwner(this.repository.getRoom(roomId), userId);

    // Validate persona ownership
    const persona = getPersonaRepository().getPersona(input.personaId);
    if (!persona || persona.userId !== userId) {
      throw new Error('Persona not found');
    }

    const member = this.repository.addMember(
      roomId,
      input.personaId,
      input.roleLabel,
      input.turnPriority ?? 1,
      input.modelOverride ?? null,
    );
    broadcastToUser(userId, GatewayEvents.ROOM_MEMBER_STATUS, {
      roomId,
      personaId: member.personaId,
      status: 'idle',
      reason: null,
      updatedAt: member.updatedAt,
    });
    return member;
  }

  removeMember(userId: string, roomId: string, personaId: string): boolean {
    assertRoomOwner(this.repository.getRoom(roomId), userId);
    return this.repository.removeMember(roomId, personaId);
  }

  setMemberPaused(
    userId: string,
    roomId: string,
    personaId: string,
    paused: boolean,
  ): RoomMemberRuntime {
    const room = assertRoomOwner(this.repository.getRoom(roomId), userId);
    const member = this.repository.listMembers(roomId).find((item) => item.personaId === personaId);
    if (!member) {
      throw new Error('Room member not found');
    }

    const existing = this.repository.getMemberRuntime(roomId, personaId);
    const updated = this.repository.upsertMemberRuntime({
      roomId,
      personaId,
      status: paused ? 'paused' : 'idle',
      busyReason: paused ? 'Paused by user' : null,
      busyUntil: null,
      currentTask: null,
      lastModel: existing?.lastModel ?? null,
      lastProfileId: existing?.lastProfileId ?? null,
      lastTool: existing?.lastTool ?? null,
    });

    broadcastToUser(room.userId, GatewayEvents.ROOM_MEMBER_STATUS, {
      roomId,
      personaId,
      status: updated.status,
      reason: updated.busyReason,
      updatedAt: updated.updatedAt,
    });

    return updated;
  }

  interruptMember(userId: string, roomId: string, personaId: string): RoomMemberRuntime {
    const room = assertRoomOwner(this.repository.getRoom(roomId), userId);
    const runtime = this.repository.getMemberRuntime(roomId, personaId);
    if (!runtime) {
      throw new Error('Member runtime not found');
    }
    if (runtime.status !== 'busy') {
      throw new Error(`Cannot interrupt member in "${runtime.status}" state`);
    }
    const updated = this.repository.upsertMemberRuntime({
      roomId,
      personaId,
      status: 'interrupting',
      busyReason: 'Interrupting…',
      currentTask: runtime.currentTask,
      lastModel: runtime.lastModel,
      lastProfileId: runtime.lastProfileId,
      lastTool: runtime.lastTool,
    });
    broadcastToUser(room.userId, GatewayEvents.ROOM_MEMBER_STATUS, {
      roomId,
      personaId,
      status: 'interrupting',
      reason: 'Interrupting…',
      updatedAt: updated.updatedAt,
    });
    return updated;
  }

  updateRunState(userId: string, roomId: string, runState: RoomRunState): Room {
    assertRoomOwner(this.repository.getRoom(roomId), userId);
    if (runState === 'stopped') {
      this.repository.closeActiveRoomRun(roomId, 'stopped', null);
    } else {
      this.repository.updateRunState(roomId, runState);
    }
    const room = this.repository.getRoom(roomId)!;
    broadcastToUser(userId, GatewayEvents.ROOM_RUN_STATUS, {
      roomId,
      runState: room.runState,
      updatedAt: room.updatedAt,
    });
    return room;
  }

  getRoomState(
    userId: string,
    roomId: string,
  ): { room: Room; members: RoomMember[]; memberRuntime: RoomMemberRuntime[] } {
    const room = assertRoomOwner(this.repository.getRoom(roomId), userId);
    const members = this.repository.listMembers(roomId);
    const memberRuntime = this.repository.listMemberRuntime(roomId);
    return { room, members, memberRuntime };
  }

  listMessages(userId: string, roomId: string, limit?: number, beforeSeq?: number): RoomMessage[] {
    assertRoomOwner(this.repository.getRoom(roomId), userId);
    return this.repository.listMessages(roomId, limit, beforeSeq);
  }

  sendUserMessage(userId: string, roomId: string, content: string): RoomMessage {
    const room = assertRoomOwner(this.repository.getRoom(roomId), userId);
    const message = this.repository.appendMessage({
      roomId,
      speakerType: 'user',
      speakerPersonaId: null,
      content,
    });
    broadcastToUser(room.userId, GatewayEvents.ROOM_MESSAGE, {
      id: message.id,
      roomId: message.roomId,
      seq: message.seq,
      speakerType: message.speakerType,
      speakerPersonaId: message.speakerPersonaId,
      content: message.content,
      createdAt: message.createdAt,
    });
    return message;
  }

  addIntervention(userId: string, roomId: string, note: string): RoomIntervention {
    assertRoomOwner(this.repository.getRoom(roomId), userId);
    const intervention = this.repository.addIntervention(roomId, userId, note);
    broadcastToUser(userId, GatewayEvents.ROOM_INTERVENTION, {
      roomId,
      interventionId: intervention.id,
      note: intervention.note,
      createdAt: intervention.createdAt,
    });
    return intervention;
  }

  listInterventions(userId: string, roomId: string, limit?: number): RoomIntervention[] {
    assertRoomOwner(this.repository.getRoom(roomId), userId);
    return this.repository.listInterventions(roomId, limit);
  }

  listActiveRoomCountsByPersona(userId: string): Record<string, number> {
    return this.repository.listActiveRoomCountsByPersona(userId);
  }
}
