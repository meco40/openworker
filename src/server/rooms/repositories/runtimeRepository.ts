import { toMemberRuntime } from '../roomRowMappers';
import type {
  RoomMemberRuntime,
  UpsertMemberRuntimeInput,
} from '../types';
import { BaseRepository } from './baseRepository';

/**
 * Repository for room member runtime-related operations.
 */
export class RuntimeRepository extends BaseRepository {
  upsertMemberRuntime(input: UpsertMemberRuntimeInput): RoomMemberRuntime {
    const now = this.now();
    this.db
      .prepare(
        `
        INSERT INTO room_member_runtime (
          room_id, persona_id, status, busy_reason, busy_until, current_task, last_model, last_profile_id, last_tool, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(room_id, persona_id) DO UPDATE SET
          status = excluded.status,
          busy_reason = excluded.busy_reason,
          busy_until = excluded.busy_until,
          current_task = excluded.current_task,
          last_model = excluded.last_model,
          last_profile_id = excluded.last_profile_id,
          last_tool = excluded.last_tool,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        input.roomId,
        input.personaId,
        input.status,
        input.busyReason || null,
        input.busyUntil || null,
        input.currentTask || null,
        input.lastModel || null,
        input.lastProfileId || null,
        input.lastTool || null,
        now,
      );

    return this.getMemberRuntime(input.roomId, input.personaId)!;
  }

  getMemberRuntime(roomId: string, personaId: string): RoomMemberRuntime | null {
    const row = this.db
      .prepare('SELECT * FROM room_member_runtime WHERE room_id = ? AND persona_id = ?')
      .get(roomId, personaId) as Record<string, unknown> | undefined;
    return row ? toMemberRuntime(row) : null;
  }

  listMemberRuntime(roomId: string): RoomMemberRuntime[] {
    const rows = this.db
      .prepare('SELECT * FROM room_member_runtime WHERE room_id = ? ORDER BY updated_at DESC')
      .all(roomId) as Array<Record<string, unknown>>;
    return rows.map(toMemberRuntime);
  }
}
