import { rmSync } from 'node:fs';

const SQLITE_SIDECAR_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;

function canIgnoreRemovalError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = String((error as NodeJS.ErrnoException).code || '');
  return code === 'ENOENT' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

export function cleanupSqliteArtifacts(dbPath: string): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const candidate = `${dbPath}${suffix}`;
    try {
      rmSync(candidate, { force: false });
    } catch (error) {
      if (!canIgnoreRemovalError(error)) {
        throw error;
      }
    }
  }
}
