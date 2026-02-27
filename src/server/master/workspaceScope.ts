import fs from 'node:fs';
import path from 'node:path';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { getPersonaWorkspaceDir } from '@/server/personas/personaWorkspace';
import type { WorkspaceScope } from '@/server/master/types';

export interface MasterWorkspaceBinding extends WorkspaceScope {
  personaId: string;
  personaWorkspaceRoot: string;
  workspaceCwd: string;
}

export function resolveMasterWorkspaceScope(input: {
  userId: string;
  personaId?: string | null;
  workspaceId?: string | null;
  workspaceCwd?: string | null;
}): MasterWorkspaceBinding {
  const userId = String(input.userId || '').trim();
  const personaId = String(input.personaId || '').trim();
  const workspaceId = String(input.workspaceId || '').trim();
  const requestedCwd = String(input.workspaceCwd || '').trim();

  if (!userId) {
    throw new Error('userId is required for master workspace scope.');
  }
  if (!personaId) {
    throw new Error('personaId is required for master workspace scope.');
  }
  if (!workspaceId) {
    throw new Error('workspaceId is required for master workspace scope.');
  }

  const persona = getPersonaRepository().getPersona(personaId);
  if (!persona || persona.userId !== userId) {
    throw new Error('Persona not found for user scope.');
  }

  const personaWorkspaceRoot = path.resolve(getPersonaWorkspaceDir(persona.slug));
  const workspaceCwd = requestedCwd ? path.resolve(requestedCwd) : personaWorkspaceRoot;
  if (!isWithinRoot(workspaceCwd, personaWorkspaceRoot)) {
    throw new Error('workspaceCwd must resolve inside persona workspace root.');
  }
  fs.mkdirSync(workspaceCwd, { recursive: true });

  return {
    userId,
    workspaceId: `persona:${personaId}:${workspaceId}`,
    personaId,
    personaWorkspaceRoot,
    workspaceCwd,
  };
}

function isWithinRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedRoot = normalizePath(root);
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function normalizePath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
