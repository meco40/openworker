import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensurePersonaWorkspace, getPersonaWorkspaceDir } from '@/server/personas/personaWorkspace';

const PROJECTS_DIR_NAME = 'projects';
const PROJECT_OVERVIEW_FILENAME = 'PROJECT.md';
const PROJECT_MAX_SLUG_LENGTH = 48;

export interface PersonaProjectWorkspace {
  projectId: string;
  projectSlug: string;
  absolutePath: string;
  relativePath: string;
  createdAt: string;
}

export function getPersonaProjectsDir(personaSlug: string): string {
  assertSafePersonaSlug(personaSlug);
  ensurePersonaWorkspace(personaSlug);
  const projectsDir = path.join(getPersonaWorkspaceDir(personaSlug), PROJECTS_DIR_NAME);
  fs.mkdirSync(projectsDir, { recursive: true });
  return projectsDir;
}

export function slugifyProjectName(name: string): string {
  const normalized = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'task';
}

export function createPersonaProjectWorkspace(input: {
  personaSlug: string;
  task: string;
  requestedName?: string;
}): PersonaProjectWorkspace {
  const personaSlug = String(input.personaSlug || '').trim();
  assertSafePersonaSlug(personaSlug);

  const projectsDir = getPersonaProjectsDir(personaSlug);
  const projectName = inferProjectName(input.requestedName, input.task);
  const projectSlug = slugifyProjectName(projectName).slice(0, PROJECT_MAX_SLUG_LENGTH) || 'task';
  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const entropy = crypto.randomUUID().slice(0, 8);
  const projectId = `${timestamp}-${projectSlug}-${entropy}`;
  const absolutePath = path.join(projectsDir, projectId);

  fs.mkdirSync(absolutePath, { recursive: true });
  for (const dirName of ['app', 'docs', 'logs', 'tmp']) {
    fs.mkdirSync(path.join(absolutePath, dirName), { recursive: true });
  }

  const overviewLines = [
    '# Project Workspace',
    '',
    `- Persona: ${personaSlug}`,
    `- Project ID: ${projectId}`,
    `- Created At: ${createdAt}`,
    '',
    '## Task',
    input.task.trim() || '(empty task)',
    '',
    '## Notes',
    '- This folder is auto-created for a delegated task.',
    '- Subagents can use this as their default working directory.',
  ];
  fs.writeFileSync(
    path.join(absolutePath, PROJECT_OVERVIEW_FILENAME),
    overviewLines.join('\n'),
    'utf8',
  );

  return {
    projectId,
    projectSlug,
    absolutePath,
    relativePath: path.posix.join('personas', personaSlug, PROJECTS_DIR_NAME, projectId),
    createdAt,
  };
}

export function removePersonaProjectWorkspace(input: {
  personaSlug: string;
  workspacePath: string;
}): void {
  const personaSlug = String(input.personaSlug || '').trim();
  assertSafePersonaSlug(personaSlug);
  const targetWorkspacePath = String(input.workspacePath || '').trim();
  if (!targetWorkspacePath) {
    throw new Error('workspacePath is required');
  }

  const projectsDir = getPersonaProjectsDir(personaSlug);
  const resolvedTargetPath = path.resolve(targetWorkspacePath);
  const relativePath = path.relative(projectsDir, resolvedTargetPath);
  if (
    !relativePath ||
    relativePath === '.' ||
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('Project workspace path is outside the persona projects directory.');
  }

  fs.rmSync(resolvedTargetPath, { recursive: true, force: true });
}

function inferProjectName(requestedName: string | undefined, task: string): string {
  const explicit = String(requestedName || '').trim();
  if (explicit) return explicit;

  const normalizedTask = String(task || '').trim();
  if (!normalizedTask) return 'task';

  const namedMatch = /(?:name(?:d)?|mit dem namen)\s+["']?([a-zA-Z0-9 _-]{2,80})/i.exec(
    normalizedTask,
  );
  if (namedMatch && namedMatch[1]) {
    return namedMatch[1].trim();
  }

  const words = normalizedTask
    .replace(/[^\w\s-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  return words.join(' ') || 'task';
}

function assertSafePersonaSlug(value: string): void {
  if (!value || value.includes('/') || value.includes('\\')) {
    throw new Error('Invalid persona slug for project workspace.');
  }
}
