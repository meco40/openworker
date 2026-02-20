import { toMember } from '@/server/rooms/roomRowMappers';
import type { RoomMember } from '@/server/rooms/types';
import { BaseRepository } from '@/server/rooms/repositories/baseRepository';

/**
 * Repository for room member-related operations.
 */
export class MemberRepository extends BaseRepository {
  addMember(
    roomId: string,
    personaId: string,
    roleLabel: string,
    turnPriority = 1,
    modelOverride: string | null = null,
  ): RoomMember {
    const now = this.now();
    try {
      this.db
        .prepare(
          `
          INSERT INTO room_members (
            room_id, persona_id, role_label, turn_priority, model_override, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(roomId, personaId, roleLabel, turnPriority, modelOverride, now, now);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) {
        throw new Error(`Persona ${personaId} is already a room member`);
      }
      throw error;
    }

    return this.listMembers(roomId).find((m) => m.personaId === personaId)!;
  }

  removeMember(roomId: string, personaId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM room_members WHERE room_id = ? AND persona_id = ?')
      .run(roomId, personaId);
    return result.changes > 0;
  }

  listMembers(roomId: string): RoomMember[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM room_members WHERE room_id = ? ORDER BY turn_priority ASC, created_at ASC',
      )
      .all(roomId) as Array<Record<string, unknown>>;
    return rows.map(toMember);
  }

  getMetrics(): {
    totalMembers: number;
  } {
    const totalMembers = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM room_members').get() as { count: number })
        .count || 0,
    );

    return { totalMembers };
  }
}
