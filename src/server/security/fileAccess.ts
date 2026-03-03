import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

type AllowedPathResult = {
  ok: true;
  resolvedPath: string;
};

type RejectedPathResult = {
  ok: false;
  status: number;
  error: string;
};

export type ResolveAllowedPathResult = AllowedPathResult | RejectedPathResult;

function expandHomePath(inputPath: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return inputPath;
  return inputPath.replace(/^~(?=$|[/\\])/, home);
}

function normalizeForComparison(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const normalizedCandidate = normalizeForComparison(candidatePath);
  const normalizedRoot = normalizeForComparison(rootPath);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveAllowedRoots(): string[] {
  const configuredRoots = [process.env.WORKSPACE_BASE_PATH, process.env.PROJECTS_PATH]
    .map((value) => String(value || '').trim())
    .filter((value) => value.length > 0)
    .map((value) => path.resolve(expandHomePath(value)));

  return configuredRoots.map((rootPath) =>
    existsSync(rootPath) ? realpathSync.native(rootPath) : rootPath,
  );
}

export function resolveAllowedExistingPath(rawPath: string): ResolveAllowedPathResult {
  const trimmedPath = String(rawPath || '').trim();
  if (!trimmedPath) {
    return { ok: false, status: 400, error: 'path is required' };
  }

  const absolutePath = path.resolve(expandHomePath(trimmedPath));
  if (!existsSync(absolutePath)) {
    return { ok: false, status: 404, error: 'File or directory not found' };
  }

  const allowedRoots = resolveAllowedRoots();
  if (allowedRoots.length === 0) {
    return { ok: false, status: 500, error: 'Allowed file roots are not configured' };
  }

  const resolvedPath = realpathSync.native(absolutePath);
  const isAllowed = allowedRoots.some((allowedRoot) => isPathWithinRoot(resolvedPath, allowedRoot));
  if (!isAllowed) {
    return { ok: false, status: 403, error: 'Path not allowed' };
  }

  return { ok: true, resolvedPath };
}
