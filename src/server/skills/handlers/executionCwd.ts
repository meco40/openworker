import fs from 'node:fs';
import path from 'node:path';
import { getPersonasRootDir } from '@/server/personas/personaWorkspace';
import type { SkillDispatchContext } from '@/server/skills/types';

export function resolveSkillExecutionCwd(context?: SkillDispatchContext): string {
  const requested = String(context?.workspaceCwd || '').trim();
  if (!requested) {
    return process.cwd();
  }

  const resolvedRequested = path.resolve(requested);
  const personasRoot = path.resolve(getPersonasRootDir());
  if (!isWithinRoot(resolvedRequested, personasRoot)) {
    throw new Error('workspaceCwd must resolve inside persona workspace root.');
  }

  fs.mkdirSync(personasRoot, { recursive: true });
  assertRealPathWithinRoot(resolvedRequested, personasRoot);
  fs.mkdirSync(resolvedRequested, { recursive: true });
  return fs.realpathSync(resolvedRequested);
}

export function assertRealPathWithinRoot(candidate: string, root: string): void {
  let existing = candidate;
  for (;;) {
    try {
      fs.lstatSync(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  if (!isWithinRoot(fs.realpathSync(existing), fs.realpathSync(root))) {
    throw new Error('Path escapes workspace root through a symbolic link.');
  }
}

export function isWithinRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedRoot = normalizePath(root);
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function normalizePath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
