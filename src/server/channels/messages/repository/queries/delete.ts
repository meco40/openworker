import type BetterSqlite3 from 'better-sqlite3';

export class DeleteQueries {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly normalizeUserId: (userId?: string) => string,
  ) {}

  private isCorruptionError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return msg.includes('malformed') || msg.includes('corrupt');
  }

  private deleteMessagesByConversation(conversationId: string): void {
    try {
      this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
    } catch (error: unknown) {
      if (this.isCorruptionError(error)) {
        this.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
        this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
        return;
      }
      throw error;
    }
  }

  private deleteSingleMessage(messageId: string, normalizedUserId: string): number {
    try {
      const result = this.db
        .prepare(
          `
          DELETE FROM messages
          WHERE id = ?
            AND conversation_id IN (
              SELECT id FROM conversations WHERE user_id = ?
            )
          `,
        )
        .run(messageId, normalizedUserId);
      return Number(result.changes || 0);
    } catch (error: unknown) {
      if (this.isCorruptionError(error)) {
        this.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
        const retryResult = this.db
          .prepare(
            `
            DELETE FROM messages
            WHERE id = ?
              AND conversation_id IN (
                SELECT id FROM conversations WHERE user_id = ?
              )
            `,
          )
          .run(messageId, normalizedUserId);
        return Number(retryResult.changes || 0);
      }
      throw error;
    }
  }

  private clearConversationDerivedState(conversationId: string): void {
    this.db.prepare('DELETE FROM conversation_context WHERE conversation_id = ?').run(conversationId);
    for (const table of [
      'knowledge_ingestion_checkpoints',
      'knowledge_episodes',
      'knowledge_meeting_ledger',
      'knowledge_retrieval_audit',
    ]) {
      try {
        this.db.prepare(`DELETE FROM "${table}" WHERE conversation_id = ?`).run(conversationId);
      } catch {
        /* table may not exist in test / memory DBs */
      }
    }
  }

  deleteConversation(
    id: string,
    userId: string,
    getConversation: (id: string, userId?: string) => unknown | null,
  ): boolean {
    const normalizedUserId = this.normalizeUserId(userId);
    const conv = getConversation(id, normalizedUserId);
    if (!conv) return false;

    this.deleteMessagesByConversation(id);

    // Delete context + knowledge artefacts + conversation
    this.clearConversationDerivedState(id);
    try {
      this.db.prepare('DELETE FROM agent_room_swarms WHERE conversation_id = ?').run(id);
    } catch {
      /* table may not exist in legacy / isolated test DBs */
    }
    try {
      this.db.prepare('DELETE FROM conversation_project_state WHERE conversation_id = ?').run(id);
    } catch {
      /* table may not exist in legacy / isolated test DBs */
    }
    this.db
      .prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
      .run(id, normalizedUserId);
    return true;
  }

  deleteMessage(
    id: string,
    userId: string,
    getMessage: (id: string, userId?: string) => { conversationId: string } | null,
  ): boolean {
    const normalizedUserId = this.normalizeUserId(userId);
    const message = getMessage(id, normalizedUserId);
    if (!message) return false;

    const deletedRows = this.deleteSingleMessage(id, normalizedUserId);
    if (deletedRows <= 0) return false;

    this.clearConversationDerivedState(message.conversationId);
    this.db
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?')
      .run(new Date().toISOString(), message.conversationId, normalizedUserId);
    return true;
  }
}
