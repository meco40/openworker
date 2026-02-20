import crypto from 'node:crypto';
import { toRoom } from '@/server/rooms/roomRowMappers';
import type { CreateRoomInput, Room, RoomRunState } from '@/server/rooms/types';
import { BaseRepository } from '@/server/rooms/repositories/baseRepository';

/**
 * Repository for room-related operations.
 */
export class RoomRepository extends BaseRepository {
  createRoom(input: CreateRoomInput): Room {
    const id = crypto.randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `
        INSERT INTO rooms (id, user_id, name, description, goal_mode, routing_profile_id, run_state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'stopped', ?, ?)
      `,
      )
      .run(
        id,
        input.userId,
        input.name,
        input.description ?? null,
        input.goalMode,
        input.routingProfileId,
        now,
        now,
      );
    return this.getRoom(id)!;
  }

  getRoom(id: string): Room | null {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toRoom(row) : null;
  }

  listRooms(userId: string): Room[] {
    const rows = this.db
      .prepare('SELECT * FROM rooms WHERE user_id = ? ORDER BY updated_at DESC')
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map(toRoom);
  }

  deleteRoom(roomId: string): boolean {
    const result = this.db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
    return result.changes > 0;
  }

  listRunningRooms(): Room[] {
    const rows = this.db
      .prepare("SELECT * FROM rooms WHERE run_state = 'running' ORDER BY updated_at DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(toRoom);
  }

  updateRunState(roomId: string, runState: RoomRunState): Room {
    const now = this.now();
    this.db
      .prepare('UPDATE rooms SET run_state = ?, updated_at = ? WHERE id = ?')
      .run(runState, now, roomId);

    const room = this.getRoom(roomId);
    if (!room) {
      throw new Error(`Room not found: ${roomId}`);
    }
    return room;
  }

  getMetrics(): {
    totalRooms: number;
    runningRooms: number;
  } {
    const totalRooms = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM rooms').get() as { count: number }).count ||
        0,
    );
    const runningRooms = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS count FROM rooms WHERE run_state = 'running'")
          .get() as { count: number }
      ).count || 0,
    );

    return { totalRooms, runningRooms };
  }
}
