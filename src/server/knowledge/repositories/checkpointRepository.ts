import type BetterSqlite3 from 'better-sqlite3';
import type { KnowledgeCheckpoint, UpsertKnowledgeCheckpointInput } from '@/server/knowledge/repository';

export class CheckpointRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  getIngestionCheckpoint(conversationId: string, personaId: string): KnowledgeCheckpoint | null {
    const row = this.db
      .prepare(
        `
        SELECT conversation_id, persona_id, last_seq, updated_at
        FROM knowledge_ingestion_checkpoints
        WHERE conversation_id = ? AND persona_id = ?
        LIMIT 1
      `,
      )
      .get(conversationId, personaId) as
      | {
          conversation_id: string;
          persona_id: string;
          last_seq: number;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;

    return {
      conversationId: row.conversation_id,
      personaId: row.persona_id,
      lastSeq: Number(row.last_seq || 0),
      updatedAt: row.updated_at,
    };
  }

  upsertIngestionCheckpoint(input: UpsertKnowledgeCheckpointInput): KnowledgeCheckpoint {
    const now = new Date().toISOString();
    const lastSeq = Math.max(0, Math.floor(Number(input.lastSeq || 0)));

    this.db
      .prepare(
        `
        INSERT INTO knowledge_ingestion_checkpoints (conversation_id, persona_id, last_seq, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_id, persona_id)
        DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at
      `,
      )
      .run(input.conversationId, input.personaId, lastSeq, now);

    return {
      conversationId: input.conversationId,
      personaId: input.personaId,
      lastSeq,
      updatedAt: now,
    };
  }
}
