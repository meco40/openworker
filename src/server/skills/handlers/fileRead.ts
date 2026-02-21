import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILE_BYTES = 256_000;
const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const ALLOWED_TOP_LEVEL_DIRS = new Set([
  'app',
  'components',
  'core',
  'docs',
  'lib',
  'messenger',
  'ops',
  'services',
  'skills',
  'src',
  'styles',
  'tests',
  'types',
]);
const ALLOWED_TOP_LEVEL_FILES = new Set([
  'README.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'next.config.ts',
  '.oxlintrc.json',
]);

function ensureWorkspacePath(userPath: string): string {
  const normalized = userPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const [head, ...tail] = normalized.split('/').filter(Boolean);
  if (!head) {
    throw new Error('Path must reference a workspace file.');
  }

  let resolved: string;
  if (ALLOWED_TOP_LEVEL_DIRS.has(head)) {
    resolved = path.resolve(WORKSPACE_ROOT, head, tail.join('/'));
  } else if (ALLOWED_TOP_LEVEL_FILES.has(head) && tail.length === 0) {
    resolved = path.resolve(WORKSPACE_ROOT, head);
  } else {
    throw new Error(`Path is not in an allowed workspace location: ${head}`);
  }

  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    throw new Error('Path escapes workspace root.');
  }

  return resolved;
}

export async function fileReadHandler(args: Record<string, unknown>) {
  const inputPath = String(args.path || '').trim();
  if (!inputPath) throw new Error('file_read requires a non-empty path.');
  const resolvedPath = ensureWorkspacePath(inputPath);

  const content = await readFile(resolvedPath, 'utf-8');
  const truncated = content.length > MAX_FILE_BYTES;
  return {
    path: inputPath,
    resolvedPath,
    truncated,
    content: truncated ? content.slice(0, MAX_FILE_BYTES) : content,
  };
}
