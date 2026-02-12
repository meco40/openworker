import type {
  Room,
  RoomIntervention,
  RoomMember,
  RoomMemberRuntime,
  RoomMessage,
  RoomPersonaContext,
  RoomPersonaSession,
  RoomRun,
  RoomRunState,
} from './types';

export function toRoom(row: Record<string, unknown>): Room {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    description: (row.description as string) || null,
    goalMode: row.goal_mode as Room['goalMode'],
    routingProfileId: row.routing_profile_id as string,
    runState: row.run_state as RoomRunState,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function toMember(row: Record<string, unknown>): RoomMember {
  return {
    roomId: row.room_id as string,
    personaId: row.persona_id as string,
    roleLabel: row.role_label as string,
    turnPriority: row.turn_priority as number,
    modelOverride: (row.model_override as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function toRoomMessage(row: Record<string, unknown>): RoomMessage {
  return {
    id: row.id as string,
    roomId: row.room_id as string,
    seq: row.seq as number,
    speakerType: row.speaker_type as RoomMessage['speakerType'],
    speakerPersonaId: (row.speaker_persona_id as string) || null,
    content: row.content as string,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json as string) as Record<string, unknown>)
      : {},
    createdAt: row.created_at as string,
  };
}

export function toIntervention(row: Record<string, unknown>): RoomIntervention {
  return {
    id: row.id as string,
    roomId: row.room_id as string,
    userId: row.user_id as string,
    note: row.note as string,
    createdAt: row.created_at as string,
  };
}

export function toRun(row: Record<string, unknown>): RoomRun {
  return {
    id: row.id as string,
    roomId: row.room_id as string,
    runState: row.run_state as RoomRunState,
    leaseOwner: (row.lease_owner as string) || null,
    leaseExpiresAt: (row.lease_expires_at as string) || null,
    heartbeatAt: (row.heartbeat_at as string) || null,
    failureReason: (row.failure_reason as string) || null,
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function toMemberRuntime(row: Record<string, unknown>): RoomMemberRuntime {
  return {
    roomId: row.room_id as string,
    personaId: row.persona_id as string,
    status: row.status as RoomMemberRuntime['status'],
    busyReason: (row.busy_reason as string) || null,
    busyUntil: (row.busy_until as string) || null,
    currentTask: (row.current_task as string) || null,
    lastModel: (row.last_model as string) || null,
    lastProfileId: (row.last_profile_id as string) || null,
    lastTool: (row.last_tool as string) || null,
    updatedAt: row.updated_at as string,
  };
}

export function toPersonaSession(row: Record<string, unknown>): RoomPersonaSession {
  return {
    roomId: row.room_id as string,
    personaId: row.persona_id as string,
    providerId: row.provider_id as string,
    model: row.model as string,
    sessionId: row.session_id as string,
    updatedAt: row.updated_at as string,
  };
}

export function toPersonaContext(row: Record<string, unknown>): RoomPersonaContext {
  return {
    roomId: row.room_id as string,
    personaId: row.persona_id as string,
    summary: row.summary_text as string,
    lastMessageSeq: row.last_message_seq as number,
    updatedAt: row.updated_at as string,
  };
}
