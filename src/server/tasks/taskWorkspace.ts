import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE_METADATA_FILENAME = '.workspace.json';
const DEFAULT_CLEANUP_MAX_REMOVALS = 200;

interface TaskWorkspaceMetadata {
  taskId: string;
  type: string;
  createdAt: string;
  version: number;
}

export interface TaskWorkspaceCleanupReasonCounts {
  activeTask: number;
  missingMetadata: number;
  invalidMetadata: number;
  protected: number;
  limitReached: number;
  removeFailed: number;
}

export interface TaskWorkspaceCleanupReport {
  scanned: number;
  removed: number;
  kept: number;
  skipped: number;
  reasonCounts: TaskWorkspaceCleanupReasonCounts;
}

function resolveTaskWorkspacesRoot(): string {
  const configuredRoot = process.env.TASK_WORKSPACES_ROOT;
  if (configuredRoot && configuredRoot.trim().length > 0) {
    return path.resolve(configuredRoot);
  }
  return path.resolve(process.cwd(), 'workspaces');
}

function sanitizeTaskWorkspaceDirectoryName(taskId: string): string {
  const normalized = String(taskId || '').trim();
  const fallback = normalized.length > 0 ? normalized : 'task-unknown';
  const withoutControlChars = Array.from(fallback)
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('');
  const safe = withoutControlChars
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .replace(/^\.+$/g, 'task-unknown');
  return safe.length > 0 ? safe : 'task-unknown';
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

type WorkspaceMetadataReadResult =
  | { status: 'ok'; metadata: TaskWorkspaceMetadata }
  | { status: 'missing' }
  | { status: 'invalid' };

function isValidIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function normalizeTaskWorkspaceMetadata(
  raw: Partial<TaskWorkspaceMetadata>,
): TaskWorkspaceMetadata | null {
  const taskId = String(raw.taskId || '').trim();
  if (taskId.length < 1) return null;

  const type = String(raw.type || '').trim() || 'general';
  const createdAtRaw = String(raw.createdAt || '').trim();
  const createdAt = isValidIsoTimestamp(createdAtRaw) ? createdAtRaw : new Date().toISOString();

  return {
    taskId,
    type,
    createdAt,
    version: Number(raw.version) === 1 ? 1 : 1,
  };
}

function readWorkspaceMetadata(dirPath: string): WorkspaceMetadataReadResult {
  const metadataPath = path.join(dirPath, WORKSPACE_METADATA_FILENAME);
  if (!fs.existsSync(metadataPath)) return { status: 'missing' };

  try {
    const raw = fs.readFileSync(metadataPath, 'utf8');
    const parsed = normalizeTaskWorkspaceMetadata(
      JSON.parse(raw) as Partial<TaskWorkspaceMetadata>,
    );
    if (!parsed) return { status: 'invalid' };
    return { status: 'ok', metadata: parsed };
  } catch {
    return { status: 'invalid' };
  }
}

function readWorkspaceTaskId(dirPath: string): string | null {
  const result = readWorkspaceMetadata(dirPath);
  return result.status === 'ok' ? result.metadata.taskId : null;
}

function resolveTaskWorkspaceDirectory(taskId: string): string {
  const rootPath = resolveTaskWorkspacesRoot();
  const dirName = sanitizeTaskWorkspaceDirectoryName(taskId);
  const resolved = path.resolve(rootPath, dirName);
  if (!isWithinRoot(resolved, rootPath)) {
    throw new Error('Task workspace path escapes root.');
  }
  return resolved;
}

function ensureTaskWorkspaceRoot(rootPath: string): void {
  fs.mkdirSync(rootPath, { recursive: true });
}

export function ensureTaskWorkspace(taskId: string, type = 'general'): string {
  const rootPath = resolveTaskWorkspacesRoot();
  ensureTaskWorkspaceRoot(rootPath);

  const workspaceDir = resolveTaskWorkspaceDirectory(taskId);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'logs'), { recursive: true });

  const metadataPath = path.join(workspaceDir, WORKSPACE_METADATA_FILENAME);
  const existingMetadata = readWorkspaceMetadata(workspaceDir);
  const existingTaskId = existingMetadata.status === 'ok' ? existingMetadata.metadata.taskId : null;
  const existingCreatedAt =
    existingMetadata.status === 'ok' ? existingMetadata.metadata.createdAt : null;
  const createdAt =
    existingCreatedAt && isValidIsoTimestamp(existingCreatedAt)
      ? existingCreatedAt
      : new Date().toISOString();
  const metadata: TaskWorkspaceMetadata = {
    taskId: existingTaskId ?? taskId,
    type,
    createdAt,
    version: 1,
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  return workspaceDir;
}

export function deleteTaskWorkspace(taskId: string): void {
  const rootPath = resolveTaskWorkspacesRoot();
  if (!fs.existsSync(rootPath)) return;

  const candidateDirs = new Set<string>();
  const deterministicDir = resolveTaskWorkspaceDirectory(taskId);
  candidateDirs.add(deterministicDir);

  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(rootPath, entry.name);
    const metadataTaskId = readWorkspaceTaskId(dirPath);
    if (metadataTaskId === taskId) {
      candidateDirs.add(dirPath);
    }
  }

  for (const dirPath of candidateDirs) {
    if (!fs.existsSync(dirPath)) continue;
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function resolveCleanupMaxRemovalsPerRun(): number {
  const configured = Number(process.env.TASK_WORKSPACES_CLEANUP_MAX_REMOVALS_PER_RUN);
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.floor(configured);
  }
  return DEFAULT_CLEANUP_MAX_REMOVALS;
}

export function cleanupOrphanTaskWorkspaces(
  activeTaskIds: Iterable<string>,
): TaskWorkspaceCleanupReport {
  const rootPath = resolveTaskWorkspacesRoot();
  if (!fs.existsSync(rootPath)) {
    return {
      scanned: 0,
      removed: 0,
      kept: 0,
      skipped: 0,
      reasonCounts: {
        activeTask: 0,
        missingMetadata: 0,
        invalidMetadata: 0,
        protected: 0,
        limitReached: 0,
        removeFailed: 0,
      },
    };
  }

  const activeIds = new Set<string>();
  for (const taskId of activeTaskIds) {
    const normalized = String(taskId || '').trim();
    if (normalized.length > 0) {
      activeIds.add(normalized);
    }
  }

  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  let scanned = 0;
  let removed = 0;
  let kept = 0;
  let skipped = 0;
  const reasonCounts: TaskWorkspaceCleanupReasonCounts = {
    activeTask: 0,
    missingMetadata: 0,
    invalidMetadata: 0,
    protected: 0,
    limitReached: 0,
    removeFailed: 0,
  };
  const maxRemovals = resolveCleanupMaxRemovalsPerRun();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    scanned += 1;

    if (entry.name.startsWith('.')) {
      skipped += 1;
      reasonCounts.protected += 1;
      continue;
    }

    const dirPath = path.join(rootPath, entry.name);
    const metadataResult = readWorkspaceMetadata(dirPath);
    if (metadataResult.status === 'missing') {
      skipped += 1;
      reasonCounts.missingMetadata += 1;
      continue;
    }
    if (metadataResult.status === 'invalid') {
      skipped += 1;
      reasonCounts.invalidMetadata += 1;
      continue;
    }
    const taskId = metadataResult.metadata.taskId;

    if (activeIds.has(taskId)) {
      kept += 1;
      reasonCounts.activeTask += 1;
      continue;
    }

    if (removed >= maxRemovals) {
      skipped += 1;
      reasonCounts.limitReached += 1;
      continue;
    }

    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      removed += 1;
    } catch {
      skipped += 1;
      reasonCounts.removeFailed += 1;
    }
  }

  return {
    scanned,
    removed,
    kept,
    skipped,
    reasonCounts,
  };
}
