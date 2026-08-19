import { getWorldModelDb } from '@/server/world-model/db';
import { getWorldModelConfig } from '@/server/world-model/config';

export interface OpenLoopRetrievalHit {
  id: string;
  type: string;
  status: string;
  question: string | null;
  attempts: number;
  lastAskedAt: string | null;
}

export async function searchOpenLoops(options: {
  userId: string;
  personaId: string;
  workspaceId: string;
  query?: string;
  limit?: number;
}): Promise<OpenLoopRetrievalHit[]> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) return [];
  const limit = Math.min(50, Math.max(1, options.limit ?? 10));
  const params: unknown[] = [options.userId, options.personaId, options.workspaceId];
  const conditions = [
    'user_id = $1',
    'persona_id = $2',
    'workspace_id = $3',
    "status IN ('open','scheduled','asked')",
  ];
  if (options.query?.trim()) {
    conditions.push(`LOWER(COALESCE(question, '')) LIKE $4`);
    params.push(`%${options.query.trim().toLowerCase()}%`);
  }
  params.push(limit);
  const limitParam = `$${params.length}`;
  const result = await getWorldModelDb().query<{
    id: string;
    type: string;
    status: string;
    question: string | null;
    attempts: number;
    last_asked_at: string | null;
  }>(
    `SELECT id, type, status, question, attempts, last_asked_at
     FROM world_model_open_loops WHERE ${conditions.join(' AND ')}
     ORDER BY COALESCE(last_asked_at, created_at) DESC LIMIT ${limitParam}`,
    params,
  );
  return result.rows.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    question: row.question,
    attempts: Number(row.attempts),
    lastAskedAt: row.last_asked_at,
  }));
}
