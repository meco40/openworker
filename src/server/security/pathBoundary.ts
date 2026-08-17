import path from 'node:path';

function normalizeForComparison(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * Checks a resolved path using path.relative instead of a raw prefix check.
 * A prefix check incorrectly treats sibling paths such as `/workspace-evil`
 * as children of `/workspace`.
 */
export function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = normalizeForComparison(path.resolve(candidatePath));
  const root = normalizeForComparison(path.resolve(rootPath));
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertPathWithinRoot(candidatePath: string, rootPath: string): string {
  const resolved = path.resolve(candidatePath);
  if (!isPathWithinRoot(resolved, rootPath)) {
    throw new Error('Path escapes the allowed root.');
  }
  return resolved;
}
