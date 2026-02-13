import type {
  AppendRoomMessageInput,
  CreateRoomInput,
  PersonaPermissions,
  Room,
  RoomMemberRuntime,
  RoomPersonaContext,
  RoomPersonaSession,
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
  countMessages(roomId: string): number;

  addIntervention(roomId: string, userId: string, note: string): RoomIntervention;
  listInterventions(roomId: string, limit?: number): RoomIntervention[];

  setPersonaPermissions(personaId: string, permissions: PersonaPermissions): void;
  getPersonaPermissions(personaId: string): PersonaPermissions | null;

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
    input: { providerId: string; model: string; sessionId: string },
  ): RoomPersonaSession;
  getPersonaSession(roomId: string, personaId: string): RoomPersonaSession | null;

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
