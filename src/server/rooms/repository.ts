import type {
  AppendRoomMessageInput,
  CreateRoomInput,
  Room,
  RoomMemberRuntime,
  RoomPersonaContext,
  RoomPersonaSession,
  RoomPersonaThreadMessage,
  RoomPersonaThreadRole,
  RoomIntervention,
  RoomRun,
  RoomMember,
  RoomMessage,
  RoomRunState,
  UpsertMemberRuntimeInput,
} from './types';

export interface RoomRepository {
  createRoom(input: CreateRoomInput): Room;
  getRoom(id: string): Room | null;
  listRooms(userId: string): Room[];
  deleteRoom(roomId: string): boolean;
  listRunningRooms(): Room[];
  updateRunState(roomId: string, runState: RoomRunState): Room;

  addMember(
    roomId: string,
    personaId: string,
    roleLabel: string,
    turnPriority?: number,
    modelOverride?: string | null,
  ): RoomMember;
  removeMember(roomId: string, personaId: string): boolean;
  listMembers(roomId: string): RoomMember[];

  appendMessage(input: AppendRoomMessageInput): RoomMessage;
  listMessages(roomId: string, limit?: number, beforeSeq?: number): RoomMessage[];
  listMessagesAfterSeq(roomId: string, afterSeq: number, limit?: number): RoomMessage[];
  countMessages(roomId: string): number;

  addIntervention(roomId: string, userId: string, note: string): RoomIntervention;
  listInterventions(roomId: string, limit?: number): RoomIntervention[];

  acquireRoomLease(roomId: string, leaseOwner: string, leaseExpiresAt: string): RoomRun;
  heartbeatRoomLease(
    roomId: string,
    runId: string,
    leaseOwner: string,
    leaseExpiresAt: string,
  ): RoomRun;
  getActiveRoomRun(roomId: string): RoomRun | null;
  closeActiveRoomRun(
    roomId: string,
    endedState?: RoomRunState,
    failureReason?: string | null,
  ): void;

  upsertMemberRuntime(input: UpsertMemberRuntimeInput): RoomMemberRuntime;
  getMemberRuntime(roomId: string, personaId: string): RoomMemberRuntime | null;
  listMemberRuntime(roomId: string): RoomMemberRuntime[];

  upsertPersonaSession(
    roomId: string,
    personaId: string,
    input: { providerId: string; model: string; sessionId: string; lastSeenRoomSeq?: number },
  ): RoomPersonaSession;
  getPersonaSession(roomId: string, personaId: string): RoomPersonaSession | null;
  appendPersonaThreadMessage(input: {
    roomId: string;
    personaId: string;
    role: RoomPersonaThreadRole;
    content: string;
  }): RoomPersonaThreadMessage;
  listPersonaThreadMessages(
    roomId: string,
    personaId: string,
    limit?: number,
  ): RoomPersonaThreadMessage[];

  upsertPersonaContext(
    roomId: string,
    personaId: string,
    input: { summary: string; lastMessageSeq: number },
  ): RoomPersonaContext;
  getPersonaContext(roomId: string, personaId: string): RoomPersonaContext | null;

  listActiveRoomCountsByPersona(userId: string): Record<string, number>;

  getMetrics(): {
    totalRooms: number;
    runningRooms: number;
    totalMembers: number;
    totalMessages: number;
  };
}
