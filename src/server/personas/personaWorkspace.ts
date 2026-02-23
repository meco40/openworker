import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PERSONA_FILE_NAMES, type PersonaFileName } from '@/server/personas/personaTypes';

const PERSONAS_ROOT = path.resolve('.local/personas');
const MIGRATION_MARKER_FILE = path.join(PERSONAS_ROOT, '.migration-v1.done');

const WORKSPACE_SUBDIRECTORIES = [
  'uploads',
  'uploads/images',
  'uploads/docs',
  'knowledge',
  'memory',
  'logs',
  'exports',
  'tmp',
  'config',
] as const;

export function getPersonasRootDir(): string {
  return PERSONAS_ROOT;
}

export function getMigrationMarkerPath(): string {
  return MIGRATION_MARKER_FILE;
}

export function slugifyPersonaName(name: string): string {
  const normalized = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'persona';
}

export function getPersonaWorkspaceDir(slug: string): string {
  return resolvePersonaPath(slug);
}

export function getPersonaUploadsDir(slug: string): string {
  return resolvePersonaPath(slug, 'uploads');
}

export function ensurePersonaWorkspace(slug: string): void {
  for (const subdir of WORKSPACE_SUBDIRECTORIES) {
    fs.mkdirSync(resolvePersonaPath(slug, subdir), { recursive: true });
  }
}

export function getPersonaFilePath(slug: string, filename: PersonaFileName): string {
  return resolvePersonaPath(slug, filename);
}

export function readPersonaFile(slug: string, filename: PersonaFileName): string | null {
  const filePath = getPersonaFilePath(slug, filename);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, 'utf8');
}

export function writePersonaFile(slug: string, filename: PersonaFileName, content: string): void {
  ensurePersonaWorkspace(slug);
  fs.writeFileSync(getPersonaFilePath(slug, filename), content, 'utf8');
}

export function ensurePersonaFiles(
  slug: string,
  files?: Partial<Record<PersonaFileName, string>>,
): void {
  ensurePersonaWorkspace(slug);
  for (const filename of PERSONA_FILE_NAMES) {
    const filePath = getPersonaFilePath(slug, filename);
    if (fs.existsSync(filePath)) {
      continue;
    }
    fs.writeFileSync(filePath, files?.[filename] ?? '', 'utf8');
  }
}

export function removePersonaWorkspace(slug: string): void {
  fs.rmSync(resolvePersonaPath(slug), { recursive: true, force: true });
}

export function renamePersonaWorkspace(oldSlug: string, newSlug: string): void {
  const from = resolvePersonaPath(oldSlug);
  const to = resolvePersonaPath(newSlug);
  if (from === to) return;

  if (!fs.existsSync(from)) {
    ensurePersonaWorkspace(newSlug);
    return;
  }
  if (fs.existsSync(to)) {
    throw new Error(`Target persona workspace already exists for slug "${newSlug}".`);
  }

  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  ensurePersonaWorkspace(newSlug);
}

export function resolvePersonaAttachmentBucketByMime(mimeType: string): 'images' | 'docs' {
  return String(mimeType || '')
    .trim()
    .toLowerCase()
    .startsWith('image/')
    ? 'images'
    : 'docs';
}

export function createPersonaAttachmentStoragePath(params: {
  slug: string;
  conversationId: string;
  mimeType: string;
  safeFileName: string;
}): string {
  const bucket = resolvePersonaAttachmentBucketByMime(params.mimeType);
  const conversationSegment = toBase64Url(params.conversationId);
  const uniquePrefix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  return path.posix.join(
    'personas',
    params.slug,
    'uploads',
    bucket,
    conversationSegment,
    `${uniquePrefix}-${params.safeFileName}`,
  );
}

export function resolvePersonaScopedStoragePath(storagePath: string): string {
  const normalized = storagePath.replace(/\\/g, '/');
  if (!normalized.startsWith('personas/')) {
    throw new Error('Persona storage path must start with "personas/".');
  }

  const relative = normalized.slice('personas/'.length);
  return resolvePersonaPath(relative);
}

export function isPersonaScopedStoragePath(storagePath: string): boolean {
  return storagePath.replace(/\\/g, '/').startsWith('personas/');
}

export function ensurePersonasRoot(): void {
  fs.mkdirSync(PERSONAS_ROOT, { recursive: true });
}

function resolvePersonaPath(...segments: string[]): string {
  ensurePersonasRoot();
  const resolved = path.resolve(PERSONAS_ROOT, ...segments);
  const root = PERSONAS_ROOT.endsWith(path.sep) ? PERSONAS_ROOT : `${PERSONAS_ROOT}${path.sep}`;
  if (resolved !== PERSONAS_ROOT && !resolved.startsWith(root)) {
    throw new Error('Resolved persona path is outside of persona root.');
  }
  return resolved;
}

function toBase64Url(value: string): string {
  const normalized = value.trim();
  if (!normalized) return 'default';
  return Buffer.from(normalized, 'utf8').toString('base64url');
}
