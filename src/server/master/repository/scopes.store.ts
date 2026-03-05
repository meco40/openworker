import type { MasterSqliteDb } from '@/server/master/repository/db';
import { listAllKnownScopes } from '@/server/master/repository/migration.store';
import { toWorkspaceScope } from '@/server/master/repository/mappers';
import type { WorkspaceScope } from '@/server/master/types';

export function listKnownScopes(db: MasterSqliteDb, limit = 500): WorkspaceScope[] {
  const rows = listAllKnownScopes(db, limit);
  return rows.map(toWorkspaceScope);
}
