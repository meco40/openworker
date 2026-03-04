import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TEST_ARTIFACTS_ROOT = path.resolve('.local', 'test-artifacts');

export interface TestArtifactsStats {
  files: number;
  bytes: number;
}

export interface CleanupTestArtifactsOptions {
  root: string;
  dryRun: boolean;
  allowAnyDir?: boolean;
}

export interface CleanupTestArtifactsResult {
  root: string;
  dryRun: boolean;
  removed: boolean;
  statsBefore: TestArtifactsStats;
}

export function collectTestArtifactsStats(root: string): TestArtifactsStats {
  if (!fs.existsSync(root)) {
    return { files: 0, bytes: 0 };
  }

  const entries = fs.readdirSync(root, { recursive: true, withFileTypes: true });
  let files = 0;
  let bytes = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    files += 1;
    const candidate = path.join(entry.parentPath, entry.name);
    try {
      bytes += fs.statSync(candidate).size;
    } catch {
      // Ignore files removed concurrently.
    }
  }

  return { files, bytes };
}

export function cleanupTestArtifactsRoot(
  options: CleanupTestArtifactsOptions,
): CleanupTestArtifactsResult {
  const root = path.resolve(options.root);
  const dryRun = options.dryRun;
  const allowAnyDir = options.allowAnyDir === true;

  if (!allowAnyDir && !isWithinAllowedRoot(root, DEFAULT_TEST_ARTIFACTS_ROOT)) {
    throw new Error(
      `Refusing cleanup outside of allowed test artifacts root: ${DEFAULT_TEST_ARTIFACTS_ROOT}`,
    );
  }

  const statsBefore = collectTestArtifactsStats(root);
  let removed = false;

  if (!dryRun && fs.existsSync(root)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      removed = statsBefore.files > 0;
    } catch (error) {
      if (!isTransientCleanupError(error)) {
        throw error;
      }
      console.warn(
        `[test-artifacts] cleanup skipped for locked path: ${root} (${(error as { code?: string }).code || 'UNKNOWN'})`,
      );
    }
  }

  return {
    root,
    dryRun,
    removed,
    statsBefore,
  };
}

function isTransientCleanupError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = String((error as { code?: unknown }).code || '');
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'ENOTEMPTY';
}

function isWithinAllowedRoot(candidatePath: string, allowedRoot: string): boolean {
  if (candidatePath === allowedRoot) {
    return true;
  }
  const prefix = allowedRoot.endsWith(path.sep) ? allowedRoot : `${allowedRoot}${path.sep}`;
  return candidatePath.startsWith(prefix);
}

function parseArgs(argv: string[]): CleanupTestArtifactsOptions {
  let root = DEFAULT_TEST_ARTIFACTS_ROOT;
  let dryRun = true;
  let allowAnyDir = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--apply') {
      dryRun = false;
      continue;
    }
    if (value === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (value === '--force-any-dir') {
      allowAnyDir = true;
      continue;
    }
    if (value === '--dir') {
      const next = argv[index + 1];
      if (next) {
        root = path.resolve(next);
        index += 1;
      }
    }
  }

  return { root, dryRun, allowAnyDir };
}

function runCli(): void {
  const options = parseArgs(process.argv.slice(2));
  const result = cleanupTestArtifactsRoot(options);

  console.log(
    JSON.stringify(
      {
        root: result.root,
        dryRun: result.dryRun,
        removed: result.removed,
        files: result.statsBefore.files,
        bytes: result.statsBefore.bytes,
        megabytes: Number((result.statsBefore.bytes / (1024 * 1024)).toFixed(2)),
      },
      null,
      2,
    ),
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runCli();
}
