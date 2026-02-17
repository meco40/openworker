import {
  toPersonaSession,
  toPersonaThreadMessage,
  toPersonaContext,
} from '../roomRowMappers';
import type {
  RoomPersonaSession,
  RoomPersonaThreadMessage,
  RoomPersonaThreadRole,
  RoomPersonaContext,
} from '../types';
import { BaseRepository } from './baseRepository';

/**
 * Repository for room persona-related operations (sessions, thread messages, context).
 */
export class PersonaRepository extends BaseRepository {
  // Persona Sessions
  upsertPersonaSession(
    roomId: string,
    personaId: string,
    input: { providerId: string; model: string; sessionId: string; lastSeenRoomSeq?: number },
  ): RoomPersonaSession {
    const now = this.now();
    const lastSeenRoomSeq = input.lastSeenRoomSeq ?? 0;
    this.db
      .prepare(
        `
        INSERT INTO room_persona_sessions (
          room_id, persona_id, provider_id, model, session_id, last_seen_room_seq, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(room_id, persona_id) DO UPDATE SET
          provider_id = excluded.provider_id,
          model = excluded.model,
          session_id = excluded.session_id,
          last_seen_room_seq = excluded.last_seen_room_seq,
          updated_at = excluded.updated_at
      `,
      )
      .run(roomId, personaId, input.providerId, input.model, input.sessionId, lastSeenRoomSeq, now);
    return this.getPersonaSession(roomId, personaId)!;
  }

  getPersonaSession(roomId: string, personaId: string): RoomPersonaSession | null {
    const row = this.db
      .prepare('SELECT * FROM room_persona_sessions WHERE room_id = ? AND persona_id = ?')
      .get(roomId, personaId) as Record<string, unknown> | undefined;
    return row ? toPersonaSession(row) : null;
  }

  // Persona Thread Messages
  appendPersonaThreadMessage(input: {
    roomId: string;
    personaId: string;
    role: RoomPersonaThreadRole;
    content: string;
  }): RoomPersonaThreadMessage {
    const now = this.now();
    const result = this.db
      .prepare(
        `
        INSERT INTO room_persona_thread_messages (room_id, persona_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      )
      .run(input.roomId, input.personaId, input.role, input.content, now);

    const row = this.db
      .prepare('SELECT * FROM room_persona_thread_messages WHERE id = ?')
      .get(result.lastInsertRowid) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error('Failed to load inserted room persona thread message');
    }
    return toPersonaThreadMessage(row);
  }

  listPersonaThreadMessages(
    roomId: string,
    personaId: string,
    limit = 300,
  ): RoomPersonaThreadMessage[] {
    const cappedLimit = Math.max(1, Math.min(limit, 2000));
    const rows = this.db
      .prepare(
        `
        SELECT * FROM (
          SELECT * FROM room_persona_thread_messages
          WHERE room_id = ? AND persona_id = ?
          ORDER BY id DESC
          LIMIT ?
        ) sub ORDER BY id ASC
      `,
      )
      .all(roomId, personaId, cappedLimit) as Array<Record<string, unknown>>;
    return rows.map(toPersonaThreadMessage);
  }

  // Persona Context
  upsertPersonaContext(
    roomId: string,
    personaId: string,
    input: { summary: string; lastMessageSeq: number },
  ): RoomPersonaContext {
    const now = this.now();
    this.db
      .prepare(
        `
        INSERT INTO room_persona_context (room_id, persona_id, summary_text, last_message_seq, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(room_id, persona_id) DO UPDATE SET
          summary_text = excluded.summary_text,
          last_message_seq = excluded.last_message_seq,
          updated_at = excluded.updated_at
      `,
      )
      .run(roomId, personaId, input.summary, input.lastMessageSeq, now);
    return this.getPersonaContext(roomId, personaId)!;
  }

  getPersonaContext(roomId: string, personaId: string): RoomPersonaContext | null {
    const row = this.db
      .prepare('SELECT * FROM room_persona_context WHERE room_id = ? AND persona_id = ?')
      .get(roomId, personaId) as Record<string, unknown> | undefined;
    return row ? toPersonaContext(row) : null;
  }

  // Active room counts by persona
  listActiveRoomCountsByPersona(userId: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `
        SELECT rm.persona_id AS persona_id, COUNT(*) AS count
        FROM room_members rm
        INNER JOIN rooms r ON r.id = rm.room_id
        WHERE r.user_id = ? AND r.run_state = 'running'
        GROUP BY rm.persona_id
      `,
      )
      .all(userId) as Array<{ persona_id: string; count: number }>;

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.persona_id] = Number(row.count || 0);
    }
    return counts;
  }
}
