import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_BYTES = 256_000;

function ensureWorkspacePath(userPath: string): string {
  const workspaceRoot = process.cwd();
  const resolved = path.resolve(workspaceRoot, userPath);
  if (!resolved.startsWith(workspaceRoot)) {
    throw new Error('Path escapes workspace root.');
  }
  return resolved;
}

export async function fileReadHandler(args: Record<string, unknown>) {
  const inputPath = String(args.path || '').trim();
  if (!inputPath) throw new Error('file_read requires a non-empty path.');
  const resolvedPath = ensureWorkspacePath(inputPath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is constrained via ensureWorkspacePath.
  const content = await readFile(resolvedPath, 'utf-8');
  const truncated = content.length > MAX_FILE_BYTES;
  return {
    path: inputPath,
    resolvedPath,
    truncated,
    content: truncated ? content.slice(0, MAX_FILE_BYTES) : content,
  };
}
