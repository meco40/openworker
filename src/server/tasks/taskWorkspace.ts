import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE_METADATA_FILENAME = '.workspace.json';

interface TaskWorkspaceMetadata {
  taskId: string;
  type: string;
  createdAt: string;
  version: number;
}

export interface TaskWorkspaceCleanupReport {
  scanned: number;
  removed: number;
  kept: number;
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

function readWorkspaceTaskId(dirPath: string): string | null {
  const metadataPath = path.join(dirPath, WORKSPACE_METADATA_FILENAME);
  if (!fs.existsSync(metadataPath)) return null;

  try {
    const raw = fs.readFileSync(metadataPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TaskWorkspaceMetadata>;
    const taskId = String(parsed.taskId || '').trim();
    return taskId.length > 0 ? taskId : null;
  } catch {
    return null;
  }
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
  const existingTaskId = readWorkspaceTaskId(workspaceDir);
  const createdAt = new Date().toISOString();
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

export function cleanupOrphanTaskWorkspaces(
  activeTaskIds: Iterable<string>,
): TaskWorkspaceCleanupReport {
  const rootPath = resolveTaskWorkspacesRoot();
  if (!fs.existsSync(rootPath)) {
    return { scanned: 0, removed: 0, kept: 0 };
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

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    scanned += 1;
    const dirPath = path.join(rootPath, entry.name);
    const metadataTaskId = readWorkspaceTaskId(dirPath);
    const taskId = metadataTaskId ?? entry.name;

    if (activeIds.has(taskId)) {
      kept += 1;
      continue;
    }

    fs.rmSync(dirPath, { recursive: true, force: true });
    removed += 1;
  }

  return { scanned, removed, kept };
}
