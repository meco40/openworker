import fs from 'node:fs';
import path from 'node:path';
import { resolveSkillExecutionCwd } from '@/server/skills/handlers/executionCwd';
import type { SkillDispatchContext } from '@/server/skills/types';

function normalizePathForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isWithinRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePathForCompare(candidate);
  const normalizedRoot = normalizePathForCompare(root);
  if (normalizedCandidate === normalizedRoot) {
    return true;
  }
  return normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

export function resolveWorkspaceRoot(context?: SkillDispatchContext): string {
  return resolveSkillExecutionCwd(context);
}

export function resolveWorkspacePath(
  inputPath: string,
  context?: SkillDispatchContext,
): { workspaceRoot: string; resolvedPath: string; relativePath: string } {
  const workspaceRoot = resolveWorkspaceRoot(context);
  const requestedPath = String(inputPath || '')
    .trim()
    .replace(/\\/g, '/');
  if (!requestedPath) {
    throw new Error('Path is required.');
  }

  const resolvedPath = path.resolve(workspaceRoot, requestedPath);
  if (!isWithinRoot(resolvedPath, workspaceRoot)) {
    throw new Error('Path must stay inside workspace root.');
  }

  const relativePath = path.relative(workspaceRoot, resolvedPath).replace(/\\/g, '/');
  return {
    workspaceRoot,
    resolvedPath,
    relativePath,
  };
}

export function ensureParentDir(filePath: string): void {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
}
