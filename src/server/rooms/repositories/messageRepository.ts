import crypto from 'node:crypto';
import { toRoomMessage as toMessage } from '../roomRowMappers';
import type {
  AppendRoomMessageInput,
  RoomMessage,
} from '../types';
import { BaseRepository } from './baseRepository';

/**
 * Repository for room message-related operations.
 */
export class MessageRepository extends BaseRepository {
  appendMessage(input: AppendRoomMessageInput): RoomMessage {
    const id = crypto.randomUUID();
    const now = this.now();
    const tx = this.db.transaction((payload: AppendRoomMessageInput) => {
      this.db
        .prepare(
          `
          INSERT INTO room_message_sequences (room_id, last_seq)
          VALUES (?, 0)
          ON CONFLICT(room_id) DO NOTHING
        `,
        )
        .run(payload.roomId);

      this.db
        .prepare('UPDATE room_message_sequences SET last_seq = last_seq + 1 WHERE room_id = ?')
        .run(payload.roomId);

      const row = this.db
        .prepare('SELECT last_seq FROM room_message_sequences WHERE room_id = ?')
        .get(payload.roomId) as { last_seq: number } | undefined;
      const seq = Number(row?.last_seq || 0);
      if (!seq) {
        throw new Error(`Failed to allocate room message sequence for room ${payload.roomId}`);
      }

      this.db
        .prepare(
          `
          INSERT INTO room_messages (
            id, room_id, seq, speaker_type, speaker_persona_id, content, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          id,
          payload.roomId,
          seq,
          payload.speakerType,
          payload.speakerPersonaId || null,
          payload.content,
          JSON.stringify(payload.metadata || {}),
          now,
        );
      return seq;
    });

    const seq = tx(input);
    const row = this.db
      .prepare('SELECT * FROM room_messages WHERE room_id = ? AND seq = ?')
      .get(input.roomId, seq) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error('Failed to load inserted room message');
    }
    return toMessage(row);
  }

  listMessages(roomId: string, limit = 100, beforeSeq?: number): RoomMessage[] {
    const cappedLimit = Math.max(1, Math.min(limit, 200));
    let rows: Array<Record<string, unknown>>;
    if (typeof beforeSeq === 'number') {
      rows = this.db
        .prepare(
          `
          SELECT * FROM (
            SELECT * FROM room_messages
            WHERE room_id = ? AND seq < ?
            ORDER BY seq DESC
            LIMIT ?
          ) sub ORDER BY seq ASC
        `,
        )
        .all(roomId, beforeSeq, cappedLimit) as Array<Record<string, unknown>>;
    } else {
      rows = this.db
        .prepare(
          `
          SELECT * FROM (
            SELECT * FROM room_messages
            WHERE room_id = ?
            ORDER BY seq DESC
            LIMIT ?
          ) sub ORDER BY seq ASC
        `,
        )
        .all(roomId, cappedLimit) as Array<Record<string, unknown>>;
    }
    return rows.map(toMessage);
  }

  listMessagesAfterSeq(roomId: string, afterSeq: number, limit = 200): RoomMessage[] {
    const cappedLimit = Math.max(1, Math.min(limit, 1000));
    const rows = this.db
      .prepare(
        `
        SELECT * FROM room_messages
        WHERE room_id = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?
      `,
      )
      .all(roomId, afterSeq, cappedLimit) as Array<Record<string, unknown>>;
    return rows.map(toMessage);
  }

  countMessages(roomId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM room_messages WHERE room_id = ?')
      .get(roomId) as { count: number };
    return Number(row.count || 0);
  }

  getMetrics(): {
    totalMessages: number;
  } {
    const totalMessages = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM room_messages').get() as { count: number })
        .count || 0,
    );

    return { totalMessages };
  }
}
