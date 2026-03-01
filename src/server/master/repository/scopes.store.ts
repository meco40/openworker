import type { MasterSqliteDb } from '@/server/master/repository/db';
import { toWorkspaceScope } from '@/server/master/repository/mappers';
import type { WorkspaceScope } from '@/server/master/types';

export function listKnownScopes(db: MasterSqliteDb, limit = 500): WorkspaceScope[] {
  const rows = db
    .prepare(
      `SELECT user_id, workspace_id FROM (
         SELECT user_id, workspace_id, updated_at AS ts FROM master_runs
         UNION ALL
         SELECT user_id, workspace_id, updated_at AS ts FROM master_capability_scores
       )
       GROUP BY user_id, workspace_id
       ORDER BY MAX(ts) DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ user_id: string; workspace_id: string }>;
  return rows.map(toWorkspaceScope);
}
