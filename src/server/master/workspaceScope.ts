import fs from 'node:fs';
import path from 'node:path';
import { isMasterSystemPersonaEnabled } from '@/server/master/featureFlags';
import { getMasterRepository } from '@/server/master/runtime';
import { ensureMasterPersona } from '@/server/master/systemPersona';
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
  const workspaceId = String(input.workspaceId || '').trim();
  const requestedCwd = String(input.workspaceCwd || '').trim();

  if (!userId) {
    throw new Error('userId is required for master workspace scope.');
  }
  if (!workspaceId) {
    throw new Error('workspaceId is required for master workspace scope.');
  }

  if (!isMasterSystemPersonaEnabled()) {
    const personaId = String(input.personaId || '').trim();
    if (!personaId) {
      throw new Error('personaId is required while the Master system persona rollout is disabled.');
    }
    const legacyPersona = getPersonaRepository().getPersona(personaId);
    if (!legacyPersona || legacyPersona.userId !== userId) {
      throw new Error('personaId is invalid for the current user.');
    }
    const personaWorkspaceRoot = path.resolve(getPersonaWorkspaceDir(legacyPersona.slug));
    const legacyWorkspaceRoot = path.resolve(
      personaWorkspaceRoot,
      'projects',
      'workspaces',
      toSafeWorkspaceSegment(workspaceId),
    );
    const workspaceCwd = requestedCwd ? path.resolve(requestedCwd) : legacyWorkspaceRoot;
    if (!isWithinRoot(workspaceCwd, legacyWorkspaceRoot)) {
      throw new Error('workspaceCwd must resolve inside master workspace root.');
    }
    fs.mkdirSync(legacyWorkspaceRoot, { recursive: true });
    fs.mkdirSync(workspaceCwd, { recursive: true });

    return {
      userId,
      workspaceId: `persona:${legacyPersona.id}:${workspaceId}`,
      personaId: legacyPersona.id,
      personaWorkspaceRoot,
      workspaceCwd,
    };
  }

  const masterPersona = ensureMasterPersona(userId);
  getMasterRepository().migrateUserLegacyScopesToMasterPersona(userId, masterPersona.id);

  const personaWorkspaceRoot = path.resolve(getPersonaWorkspaceDir(masterPersona.slug));
  const masterWorkspaceRoot = path.resolve(
    personaWorkspaceRoot,
    'projects',
    'workspaces',
    toSafeWorkspaceSegment(workspaceId),
  );
  const workspaceCwd = requestedCwd ? path.resolve(requestedCwd) : masterWorkspaceRoot;
  if (!isWithinRoot(workspaceCwd, masterWorkspaceRoot)) {
    throw new Error('workspaceCwd must resolve inside master workspace root.');
  }
  fs.mkdirSync(masterWorkspaceRoot, { recursive: true });
  fs.mkdirSync(workspaceCwd, { recursive: true });

  return {
    userId,
    workspaceId: `persona:${masterPersona.id}:${workspaceId}`,
    personaId: masterPersona.id,
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

function toSafeWorkspaceSegment(value: string): string {
  const normalized = String(value || '')
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'main';
}
