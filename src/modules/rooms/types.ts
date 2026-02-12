export type RoomGoalMode = 'planning' | 'simulation';
export type RoomRunState = 'running' | 'stopped' | 'degraded';

export interface RoomSummary {
  id: string;
  name: string;
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

export interface RoomState {
  roomId: string;
  runState: RoomRunState;
  goalMode: RoomGoalMode;
  routingProfileId: string;
}

export interface RoomMessage {
  id: string;
  roomId: string;
  seq: number;
  speakerType: 'persona' | 'system' | 'user';
  speakerPersonaId: string | null;
  content: string;
  createdAt: string;
}

export interface RoomMemberStatus {
  roomId: string;
  personaId: string;
  status: 'idle' | 'busy';
  reason: string | null;
  updatedAt: string;
}

export interface RoomInterventionEvent {
  roomId: string;
  interventionId: string;
  note: string;
  createdAt: string;
}

export interface RoomRunStatusEvent {
  roomId: string;
  runState: RoomRunState;
  updatedAt: string;
}

export interface RoomMetricsEvent {
  roomId: string;
  messageCount: number;
  memberCount: number;
  generatedAt: string;
}
