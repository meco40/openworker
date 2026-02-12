export type RoomGoalMode = 'planning' | 'simulation' | 'free';

export type RoomRunState = 'stopped' | 'running' | 'degraded';

export interface Room {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  goalMode: RoomGoalMode;
  routingProfileId: string;
  runState: RoomRunState;
  createdAt: string;
  updatedAt: string;
}

export interface RoomMember {
  roomId: string;
  personaId: string;
  roleLabel: string;
  turnPriority: number;
  modelOverride: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RoomSpeakerType = 'persona' | 'system' | 'user';

export interface RoomMessage {
  id: string;
  roomId: string;
  seq: number;
  speakerType: RoomSpeakerType;
  speakerPersonaId: string | null;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface PersonaPermissions {
  tools: Record<string, boolean>;
}

export interface RoomIntervention {
  id: string;
  roomId: string;
  userId: string;
  note: string;
  createdAt: string;
}

export interface RoomRun {
  id: string;
  roomId: string;
  runState: RoomRunState;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  failureReason: string | null;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RoomMemberRuntimeStatus = 'idle' | 'busy' | 'interrupting' | 'interrupted' | 'error' | 'paused';

export interface RoomMemberRuntime {
  roomId: string;
  personaId: string;
  status: RoomMemberRuntimeStatus;
  busyReason: string | null;
  busyUntil: string | null;
  currentTask: string | null;
  lastModel: string | null;
  lastProfileId: string | null;
  lastTool: string | null;
  updatedAt: string;
}

export interface RoomPersonaSession {
  roomId: string;
  personaId: string;
  providerId: string;
  model: string;
  sessionId: string;
  updatedAt: string;
}

export interface RoomPersonaContext {
  roomId: string;
  personaId: string;
  summary: string;
  lastMessageSeq: number;
  updatedAt: string;
}

export interface UpsertMemberRuntimeInput {
  roomId: string;
  personaId: string;
  status: RoomMemberRuntimeStatus;
  busyReason?: string | null;
  busyUntil?: string | null;
  currentTask?: string | null;
  lastModel?: string | null;
  lastProfileId?: string | null;
  lastTool?: string | null;
}

export interface CreateRoomInput {
  userId: string;
  name: string;
  description?: string | null;
  goalMode: RoomGoalMode;
  routingProfileId: string;
}

export interface AppendRoomMessageInput {
  roomId: string;
  speakerType: RoomSpeakerType;
  speakerPersonaId?: string | null;
  content: string;
  metadata?: Record<string, unknown>;
}
