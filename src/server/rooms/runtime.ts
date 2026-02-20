import { RoomService } from '@/server/rooms/service';
import { SqliteRoomRepository } from '@/server/rooms/sqliteRoomRepository';
import { RoomOrchestrator, type RoomOrchestratorOptions } from '@/server/rooms/orchestrator';

let roomRepository: SqliteRoomRepository | undefined;
let roomService: RoomService | undefined;
let roomOrchestrator: RoomOrchestrator | undefined;

function resolveRoomsDbPath(): string {
  if (process.env.ROOMS_DB_PATH && process.env.ROOMS_DB_PATH.trim().length > 0) {
    return process.env.ROOMS_DB_PATH;
  }

  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
    return ':memory:';
  }

  return process.env.MESSAGES_DB_PATH || '.local/messages.db';
}

export function getRoomRepository(): SqliteRoomRepository {
  if (!roomRepository) {
    roomRepository = new SqliteRoomRepository(resolveRoomsDbPath());
  }
  return roomRepository;
}

export function getRoomService(): RoomService {
  if (!roomService) {
    roomService = new RoomService(getRoomRepository());
  }
  return roomService;
}

export function getRoomOrchestrator(options?: RoomOrchestratorOptions): RoomOrchestrator {
  if (!roomOrchestrator) {
    roomOrchestrator = new RoomOrchestrator(getRoomRepository(), options);
  }
  return roomOrchestrator;
}
