import crypto from 'node:crypto';
import { toIntervention } from '../roomRowMappers';
import type { RoomIntervention } from '../types';
import { BaseRepository } from './baseRepository';

/**
 * Repository for room intervention-related operations.
 */
export class InterventionRepository extends BaseRepository {
  addIntervention(roomId: string, userId: string, note: string): RoomIntervention {
    const id = crypto.randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `
        INSERT INTO room_interventions (id, room_id, user_id, note, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      )
      .run(id, roomId, userId, note, now);
    return { id, roomId, userId, note, createdAt: now };
  }

  listInterventions(roomId: string, limit = 50): RoomIntervention[] {
    const cappedLimit = Math.max(1, Math.min(limit, 200));
    const rows = this.db
      .prepare(
        `
        SELECT * FROM room_interventions
        WHERE room_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
      )
      .all(roomId, cappedLimit) as Array<Record<string, unknown>>;
    return rows.map(toIntervention);
  }
}
