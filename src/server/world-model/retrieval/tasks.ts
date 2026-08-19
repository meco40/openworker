import { getWorldModelDb } from '@/server/world-model/db';
import { getWorldModelConfig } from '@/server/world-model/config';

/**
 * Phase 10: Strukturiertes Task-Retrieval.
 * Findet aktive/überfällige Aufgaben nach Status und Fälligkeit.
 */

export interface TaskRetrievalHit {
  id: string;
  title: string;
  status: string;
  dueAt: string | null;
  createdAt: string;
}

export interface TaskRetrievalOptions {
  userId: string;
  personaId: string;
  workspaceId: string;
  status?: string;
  overdue?: boolean;
  limit?: number;
  query?: string;
  knownAsOf?: string;
}

export async function searchTasks(options: TaskRetrievalOptions): Promise<TaskRetrievalHit[]> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) return [];

  const db = getWorldModelDb();
  const limit = Math.min(50, Math.max(1, options.limit ?? 10));
  const conditions: string[] = ['t.user_id = $1', 't.persona_id = $2', 't.workspace_id = $3'];
  const params: unknown[] = [options.userId, options.personaId, options.workspaceId];
  let idx = 4;

  if (options.status) {
    conditions.push(`t.status = $${idx++}`);
    params.push(options.status);
  } else {
    conditions.push(`t.status IN ('proposed', 'planned', 'in_progress', 'waiting')`);
  }

  if (options.overdue) {
    conditions.push(`t.due_at IS NOT NULL AND t.due_at < now()`);
  }
  if (options.query) {
    conditions.push(`LOWER(t.title) LIKE $${idx++}`);
    params.push(`%${options.query.toLowerCase()}%`);
  }
  if (options.knownAsOf) {
    conditions.push(`t.created_at <= $${idx++}`);
    params.push(options.knownAsOf);
  }

  params.push(limit);
  const result = await db.query<{
    id: string;
    title: string;
    status: string;
    due_at: string | null;
    created_at: string;
  }>(
    `SELECT t.id, t.title, t.status, t.due_at, t.created_at
     FROM world_model_tasks t
     WHERE ${conditions.join(' AND ')}
     ORDER BY COALESCE(t.due_at, t.created_at) ASC
     LIMIT $${idx}`,
    params,
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    dueAt: row.due_at,
    createdAt: row.created_at,
  }));
}
