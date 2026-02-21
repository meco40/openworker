import type BetterSqlite3 from 'better-sqlite3';
import type { ConversationContextState } from '@/server/channels/messages/repository/types';
import type { Conversation } from '@/shared/domain/types';

export class ContextQueries {
  constructor(private readonly db: BetterSqlite3.Database) {}

  getConversationContext(
    conversationId: string,
    getConversation: (id: string, userId?: string) => Conversation | null,
    userId?: string,
  ): ConversationContextState | null {
    const conversation = getConversation(conversationId, userId);
    if (!conversation) {
      return null;
    }

    const row = this.db
      .prepare('SELECT * FROM conversation_context WHERE conversation_id = ?')
      .get(conversationId) as
      | {
          conversation_id: string;
          summary_text: string;
          summary_upto_seq: number;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      conversationId: row.conversation_id,
      summaryText: row.summary_text,
      summaryUptoSeq: row.summary_upto_seq,
      updatedAt: row.updated_at,
    };
  }

  upsertConversationContext(
    conversationId: string,
    summaryText: string,
    summaryUptoSeq: number,
    getConversation: (id: string, userId?: string) => Conversation | null,
    userId?: string,
  ): ConversationContextState {
    const conversation = getConversation(conversationId, userId);
    if (!conversation) {
      throw new Error('Conversation not found for context update.');
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO conversation_context (conversation_id, summary_text, summary_upto_seq, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_id)
        DO UPDATE SET
          summary_text = excluded.summary_text,
          summary_upto_seq = excluded.summary_upto_seq,
          updated_at = excluded.updated_at
      `,
      )
      .run(conversationId, summaryText, summaryUptoSeq, now);

    return {
      conversationId,
      summaryText,
      summaryUptoSeq,
      updatedAt: now,
    };
  }
}
