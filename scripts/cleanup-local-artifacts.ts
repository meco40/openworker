import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REMOVABLE_PREFIXES = [
  'test-event-answer-',
  'test-dedup-',
  'test-entity-graph-',
  'test-nata-scenario-',
  'worker.delete.routes.',
  'worker.metrics.route.',
  'automation.routes.',
] as const;

const STABLE_DATABASE_NAMES = new Set([
  'automation.db',
  'messages.db',
  'messages.recovered.db',
  'stats.db',
  'personas.db',
  'auth.db',
  'credentials.db',
  'gateway-config.db',
  'master.db',
  'model-hub.db',
  'openclaw.db',
  'skills.db',
  'clawhub.db',
  'logs.db',
]);

const PROTECTED_TOP_LEVEL_DIRS = new Set(['personas', 'test-artifacts']);
const TIMESTAMPED_DATABASE_PATTERN = /\.\d{8,}.*\.db(?:-(?:wal|shm))?$/;

export interface LocalArtifactCandidate {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface CleanupOptions {
  dryRun: boolean;
}

export interface CleanupResult {
  matched: number;
  deleted: number;
  failed: number;
  freedBytes: number;
}

export function shouldCleanupLocalFile(name: string): boolean {
  if (STABLE_DATABASE_NAMES.has(name)) return false;
  if (TIMESTAMPED_DATABASE_PATTERN.test(name)) return true;
  return REMOVABLE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function collectCandidatesFromDir(dir: string): LocalArtifactCandidate[] {
  const root = path.resolve(dir);
  const dirsToScan = [root];
  const candidates: LocalArtifactCandidate[] = [];

  while (dirsToScan.length > 0) {
    const currentDir = dirsToScan.pop() ?? root;
    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (isProtectedSubtree(root, fullPath)) continue;
        dirsToScan.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!shouldCleanupLocalFile(entry.name)) continue;

      const stats = statSync(fullPath);
      candidates.push({
        name: entry.name,
        path: fullPath,
        sizeBytes: stats.size,
      });
    }
  }

  return candidates.sort((left, right) => right.sizeBytes - left.sizeBytes);
}

function isProtectedSubtree(root: string, candidateDir: string): boolean {
  const relative = path.relative(root, candidateDir);
  if (!relative || relative.startsWith('..')) {
    return false;
  }

  const firstSegment = relative.split(path.sep)[0];
  return PROTECTED_TOP_LEVEL_DIRS.has(firstSegment);
}

export function cleanupCandidates(
  candidates: LocalArtifactCandidate[],
  options: CleanupOptions,
): CleanupResult {
  let deleted = 0;
  let failed = 0;
  let freedBytes = 0;

  for (const candidate of candidates) {
    if (options.dryRun) continue;

    try {
      rmSync(candidate.path, { force: false });
      deleted += 1;
      freedBytes += candidate.sizeBytes;
    } catch {
      failed += 1;
    }
  }

  return {
    matched: candidates.length,
    deleted,
    failed,
    freedBytes,
  };
}

function parseArgs(argv: string[]): { dir: string; dryRun: boolean } {
  let dir = path.resolve(process.cwd(), '.local');
  let dryRun = true;

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

    if (value === '--dir') {
      const next = argv[index + 1];
      if (next) {
        dir = path.resolve(next);
        index += 1;
      }
    }
  }

  return { dir, dryRun };
}

function toMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function runCli(): void {
  const options = parseArgs(process.argv.slice(2));
  const candidates = collectCandidatesFromDir(options.dir);
  const result = cleanupCandidates(candidates, { dryRun: options.dryRun });

  console.log(
    JSON.stringify(
      {
        dir: options.dir,
        dryRun: options.dryRun,
        matched: result.matched,
        deleted: result.deleted,
        failed: result.failed,
        freedMB: toMegabytes(result.freedBytes),
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
