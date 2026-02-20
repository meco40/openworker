import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from './repositories/migrations';
import type { RoomRepository } from './repository';
import {
  RoomRepository as RoomRepo,
  MemberRepository,
  MessageRepository,
  RunRepository,
  RuntimeRepository,
  PersonaRepository,
  InterventionRepository,
} from './repositories';

/**
 * Main SQLite implementation of the RoomRepository interface.
 *
 * This class acts as a facade, delegating all operations to specialized
 * repository classes organized by domain:
 *
 * - RoomRepo: Room CRUD and lifecycle operations
 * - MemberRepository: Room member management
 * - MessageRepository: Room message operations
 * - RunRepository: Room run/lease operations
 * - RuntimeRepository: Member runtime state
 * - PersonaRepository: Persona sessions, thread messages, context
 * - InterventionRepository: Room interventions
 */
export class SqliteRoomRepository implements RoomRepository {
  private readonly db: BetterSqlite3.Database;

  // Specialized repository instances
  private readonly roomRepo: RoomRepo;
  private readonly memberRepo: MemberRepository;
  private readonly messageRepo: MessageRepository;
  private readonly runRepo: RunRepository;
  private readonly runtimeRepo: RuntimeRepository;
  private readonly personaRepo: PersonaRepository;
  private readonly interventionRepo: InterventionRepository;

  constructor(
    dbPath = process.env.ROOMS_DB_PATH || process.env.MESSAGES_DB_PATH || '.local/messages.db',
  ) {
    // Initialize database connection
    if (dbPath === ':memory:') {
      this.db = new BetterSqlite3(':memory:');
    } else {
      const fullPath = path.resolve(dbPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new BetterSqlite3(fullPath);
    }

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    runMigrations(this.db);

    // Initialize specialized repositories with the shared database instance
    this.roomRepo = new RoomRepo(this.db);
    this.memberRepo = new MemberRepository(this.db);
    this.messageRepo = new MessageRepository(this.db);
    this.runRepo = new RunRepository(this.db);
    this.runtimeRepo = new RuntimeRepository(this.db);
    this.personaRepo = new PersonaRepository(this.db);
    this.interventionRepo = new InterventionRepository(this.db);
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Rooms
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  createRoom(input: Parameters<RoomRepo['createRoom']>[0]) {
    return this.roomRepo.createRoom(input);
  }

  getRoom(id: string) {
    return this.roomRepo.getRoom(id);
  }

  listRooms(userId: string) {
    return this.roomRepo.listRooms(userId);
  }

  deleteRoom(roomId: string) {
    return this.roomRepo.deleteRoom(roomId);
  }

  listRunningRooms() {
    return this.roomRepo.listRunningRooms();
  }

  updateRunState(roomId: string, runState: Parameters<RoomRepo['updateRunState']>[1]) {
    return this.roomRepo.updateRunState(roomId, runState);
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Members
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  addMember(
    roomId: string,
    personaId: string,
    roleLabel: string,
    turnPriority?: number,
    modelOverride?: string | null,
  ) {
    return this.memberRepo.addMember(roomId, personaId, roleLabel, turnPriority, modelOverride);
  }

  removeMember(roomId: string, personaId: string) {
    return this.memberRepo.removeMember(roomId, personaId);
  }

  listMembers(roomId: string) {
    return this.memberRepo.listMembers(roomId);
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Messages
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  appendMessage(input: Parameters<MessageRepository['appendMessage']>[0]) {
    return this.messageRepo.appendMessage(input);
  }

  listMessages(roomId: string, limit?: number, beforeSeq?: number) {
    return this.messageRepo.listMessages(roomId, limit, beforeSeq);
  }

  listMessagesAfterSeq(roomId: string, afterSeq: number, limit?: number) {
    return this.messageRepo.listMessagesAfterSeq(roomId, afterSeq, limit);
  }

  countMessages(roomId: string) {
    return this.messageRepo.countMessages(roomId);
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Interventions
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  addIntervention(roomId: string, userId: string, note: string) {
    return this.interventionRepo.addIntervention(roomId, userId, note);
  }

  listInterventions(roomId: string, limit?: number) {
    return this.interventionRepo.listInterventions(roomId, limit);
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Runs / Leases
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  acquireRoomLease(roomId: string, leaseOwner: string, leaseExpiresAt: string) {
    return this.runRepo.acquireRoomLease(roomId, leaseOwner, leaseExpiresAt);
  }

  heartbeatRoomLease(roomId: string, runId: string, leaseOwner: string, leaseExpiresAt: string) {
    return this.runRepo.heartbeatRoomLease(roomId, runId, leaseOwner, leaseExpiresAt);
  }

  getActiveRoomRun(roomId: string) {
    return this.runRepo.getActiveRoomRun(roomId);
  }

  closeActiveRoomRun(
    roomId: string,
    endedState?: Parameters<RunRepository['closeActiveRoomRun']>[1],
    failureReason?: string | null,
  ) {
    return this.runRepo.closeActiveRoomRun(roomId, endedState, failureReason);
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Runtime
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  upsertMemberRuntime(input: Parameters<RuntimeRepository['upsertMemberRuntime']>[0]) {
    return this.runtimeRepo.upsertMemberRuntime(input);
  }

  getMemberRuntime(roomId: string, personaId: string) {
    return this.runtimeRepo.getMemberRuntime(roomId, personaId);
  }

  listMemberRuntime(roomId: string) {
    return this.runtimeRepo.listMemberRuntime(roomId);
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Persona Sessions & Context
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  upsertPersonaSession(
    roomId: string,
    personaId: string,
    input: Parameters<PersonaRepository['upsertPersonaSession']>[2],
  ) {
    return this.personaRepo.upsertPersonaSession(roomId, personaId, input);
  }

  getPersonaSession(roomId: string, personaId: string) {
    return this.personaRepo.getPersonaSession(roomId, personaId);
  }

  appendPersonaThreadMessage(
    input: Parameters<PersonaRepository['appendPersonaThreadMessage']>[0],
  ) {
    return this.personaRepo.appendPersonaThreadMessage(input);
  }

  listPersonaThreadMessages(roomId: string, personaId: string, limit?: number) {
    return this.personaRepo.listPersonaThreadMessages(roomId, personaId, limit);
  }

  upsertPersonaContext(
    roomId: string,
    personaId: string,
    input: Parameters<PersonaRepository['upsertPersonaContext']>[2],
  ) {
    return this.personaRepo.upsertPersonaContext(roomId, personaId, input);
  }

  getPersonaContext(roomId: string, personaId: string) {
    return this.personaRepo.getPersonaContext(roomId, personaId);
  }

  listActiveRoomCountsByPersona(userId: string) {
    return this.personaRepo.listActiveRoomCountsByPersona(userId);
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Metrics
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  getMetrics(): {
    totalRooms: number;
    runningRooms: number;
    totalMembers: number;
    totalMessages: number;
  } {
    const roomMetrics = this.roomRepo.getMetrics();
    const memberMetrics = this.memberRepo.getMetrics();
    const messageMetrics = this.messageRepo.getMetrics();

    return {
      ...roomMetrics,
      ...memberMetrics,
      ...messageMetrics,
    };
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Lifecycle
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  close(): void {
    this.db.close();
  }
}


