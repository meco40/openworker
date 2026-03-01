import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceScope } from '@/server/master/types';
import { SqliteMasterRepository } from '@/server/master/repository/sqliteMasterRepository';
import { getTestArtifactsRoot } from '../../../helpers/testArtifacts';

export function createScope(userId: string, workspaceId: string): WorkspaceScope {
  return { userId, workspaceId };
}

function uniqueDbPath(): string {
  return path.join(
    getTestArtifactsRoot(),
    `master.repo.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

export function createRepo(): { repo: SqliteMasterRepository; dbPath: string } {
  const dbPath = uniqueDbPath();
  return { repo: new SqliteMasterRepository(dbPath), dbPath };
}

export function cleanupDb(dbPath: string): void {
  if (!fs.existsSync(dbPath)) return;
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // ignore on transient locks
  }
}
