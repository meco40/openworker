import type BetterSqlite3 from 'better-sqlite3';

export class DeleteQueries {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly normalizeUserId: (userId?: string) => string,
  ) {}

  deleteConversation(
    id: string,
    userId: string,
    getConversation: (id: string, userId?: string) => unknown | null,
  ): boolean {
    const normalizedUserId = this.normalizeUserId(userId);
    const conv = getConversation(id, normalizedUserId);
    if (!conv) return false;

    // If FTS index is corrupted, rebuild it first so DELETE triggers succeed
    try {
      this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('malformed') || msg.includes('corrupt')) {
        this.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
        this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
      } else {
        throw err;
      }
    }

    // Delete context + knowledge artefacts + conversation
    this.db.prepare('DELETE FROM conversation_context WHERE conversation_id = ?').run(id);
    try {
      this.db.prepare('DELETE FROM conversation_project_state WHERE conversation_id = ?').run(id);
    } catch {
      /* table may not exist in legacy / isolated test DBs */
    }
    for (const table of [
      'knowledge_ingestion_checkpoints',
      'knowledge_episodes',
      'knowledge_meeting_ledger',
      'knowledge_retrieval_audit',
    ]) {
      try {
        this.db.prepare(`DELETE FROM "${table}" WHERE conversation_id = ?`).run(id);
      } catch {
        /* table may not exist in test / memory DBs */
      }
    }
    this.db
      .prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
      .run(id, normalizedUserId);
    return true;
  }
}
