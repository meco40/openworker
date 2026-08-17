/**
 * Skill Installer — handles installation from GitHub, npm, or manual manifest.
 *
 * GitHub flow:
 *   1. Fetch skill.json from repo root (tries raw.githubusercontent.com)
 *   2. Validate manifest structure
 *   3. Download handler file(s) to skills/external/<skill-id>/
 *   4. Register in SQLite
 *
 * npm flow:
 *   1. Run `npm install <package>` in project root
 *   2. Look for skill.json in the installed package
 *   3. Register with handler path pointing to node_modules
 *
 * Manual flow:
 *   1. User provides a SkillManifest JSON directly
 *   2. Validate and register (no handler code — API-only skills)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { SkillManifest, ToolDefinition, BuiltInToolDefinition } from '@/shared/toolSchema';
import { getSkillRepository, type SkillRow } from '@/server/skills/skillRepository';
import { assertExternalSkillsEnabled } from '@/server/skills/externalSkillPolicy';
import { fetchWithSsrfGuard, readResponseTextLimited } from '@/server/http/ssrfGuard';
import { assertPathWithinRoot, isPathWithinRoot } from '@/server/security/pathBoundary';

const execFile = promisify(execFileCallback);

// ── Validation ───────────────────────────────────────────────────

function isValidToolDef(tool: unknown): tool is ToolDefinition | BuiltInToolDefinition {
  if (!tool || typeof tool !== 'object') return false;
  const t = tool as Record<string, unknown>;

  // Built-in check
  if (t.builtIn === true && typeof t.providerConfig === 'object') return true;

  // Standard tool check
  return (
    typeof t.name === 'string' &&
    typeof t.description === 'string' &&
    typeof t.parameters === 'object' &&
    t.parameters !== null
  );
}

function validateRelativeHandlerPath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Invalid manifest: "handler" must be a non-empty relative path.');
  }

  const handler = value.trim();
  const segments = handler.split(/[\\/]+/);
  if (
    handler.startsWith('/') ||
    handler.startsWith('\\') ||
    /^[a-z]:[\\/]/i.test(handler) ||
    segments.some((segment) => segment === '..')
  ) {
    throw new Error('Invalid manifest: "handler" must stay inside the skill directory.');
  }

  return handler;
}

function resolvePackageHandlerPath(packageDir: string, handler: string): string {
  const packageRoot = fs.realpathSync(packageDir);
  const candidate = path.resolve(packageDir, handler);
  assertPathWithinRoot(candidate, packageDir);
  if (!fs.existsSync(candidate)) {
    throw new Error(`Skill handler was not found at ${candidate}.`);
  }

  const realCandidate = fs.realpathSync(candidate);
  if (!isPathWithinRoot(realCandidate, packageRoot)) {
    throw new Error('Skill handler must stay inside the installed package.');
  }
  return path.relative(process.cwd(), realCandidate);
}

export function validateManifest(data: unknown): SkillManifest {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid manifest: expected a JSON object.');
  }
  const d = data as Record<string, unknown>;

  const required = ['id', 'name', 'description', 'version', 'category', 'functionName', 'tool'];
  for (const key of required) {
    if (!d[key]) {
      throw new Error(`Invalid manifest: missing required field "${key}".`);
    }
  }

  for (const key of ['id', 'name', 'description', 'version', 'category', 'functionName']) {
    if (typeof d[key] !== 'string' || !d[key].trim()) {
      throw new Error(`Invalid manifest: "${key}" must be a non-empty string.`);
    }
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(d.id as string)) {
    throw new Error('Invalid manifest: "id" contains unsupported characters.');
  }

  if (!isValidToolDef(d.tool)) {
    throw new Error(
      'Invalid manifest: "tool" must be a valid ToolDefinition or BuiltInToolDefinition.',
    );
  }

  const handler = validateRelativeHandlerPath(d.handler);
  return handler === undefined ? (data as SkillManifest) : ({ ...data, handler } as SkillManifest);
}

// ── GitHub ────────────────────────────────────────────────────────

function parseGitHubUrl(url: string): { owner: string; repo: string; branch: string } {
  // Support: https://github.com/owner/repo[#branch] or owner/repo[#branch]
  const cleaned = url
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  if (!cleaned) {
    throw new Error(`Cannot parse GitHub URL: ${url}`);
  }

  let repoRef = cleaned;
  if (cleaned.includes('://')) {
    let parsed: URL;
    try {
      parsed = new URL(cleaned);
    } catch {
      throw new Error(`Cannot parse GitHub URL: ${url}`);
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== 'github.com' && hostname !== 'www.github.com') {
      throw new Error(`Cannot parse GitHub URL: ${url}`);
    }
    repoRef = parsed.pathname.replace(/^\/+/, '');
  } else if (cleaned.toLowerCase().startsWith('github.com/')) {
    repoRef = cleaned.slice('github.com/'.length);
  }

  const [repoPath, branchRef] = repoRef.split(/[@#]/, 2);
  const segments = repoPath.split('/').filter(Boolean);
  if (
    segments.length !== 2 ||
    segments.some((segment) => !/^[a-z0-9._-]+$/i.test(segment)) ||
    segments.some((segment) => segment === '.' || segment === '..') ||
    (branchRef !== undefined &&
      (!/^[a-z0-9._/-]+$/i.test(branchRef) ||
        branchRef.split('/').some((segment) => segment === '.' || segment === '..')))
  ) {
    throw new Error(`Cannot parse GitHub URL: ${url}`);
  }

  return {
    owner: segments[0],
    repo: segments[1],
    branch: branchRef || 'main',
  };
}

async function fetchGitHubManifest(url: string): Promise<SkillManifest> {
  const { owner, repo, branch } = parseGitHubUrl(url);

  // Try fetching skill.json from repo root
  const manifestUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/skill.json`;
  const response = await fetchWithSsrfGuard(manifestUrl, undefined, { maxRedirects: 0 });

  if (!response.ok) {
    throw new Error(
      `Could not fetch skill.json from ${manifestUrl} (${response.status}). ` +
        'Make sure the repository has a skill.json in its root.',
    );
  }

  const data: unknown = JSON.parse(await readResponseTextLimited(response, 256_000));
  return validateManifest(data);
}

async function downloadHandler(url: string, manifest: SkillManifest): Promise<string | null> {
  if (!manifest.handler) return null;

  const { owner, repo, branch } = parseGitHubUrl(url);
  const handlerUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${manifest.handler}`;

  const response = await fetchWithSsrfGuard(handlerUrl, undefined, { maxRedirects: 0 });
  if (!response.ok) {
    throw new Error(`Could not download handler from ${handlerUrl} (${response.status}).`);
  }

  const content = await readResponseTextLimited(response, 1_000_000);
  const externalDir = path.join(process.cwd(), 'skills', 'external', manifest.id);
  fs.mkdirSync(externalDir, { recursive: true });

  const handlerFile = path.join(externalDir, path.basename(manifest.handler));
  fs.writeFileSync(handlerFile, content, 'utf-8');

  return path.relative(process.cwd(), handlerFile);
}

async function installFromGitHub(url: string): Promise<SkillRow> {
  assertExternalSkillsEnabled();
  const manifest = await fetchGitHubManifest(url);
  const handlerPath = await downloadHandler(url, manifest);

  const repo = await getSkillRepository();
  return repo.installSkill({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    category: manifest.category,
    version: manifest.version,
    functionName: manifest.functionName,
    source: 'github',
    sourceUrl: url,
    toolDefinition: manifest.tool,
    handlerPath: handlerPath ?? undefined,
  });
}

// ── npm ──────────────────────────────────────────────────────────

async function installFromNpm(packageName: string): Promise<SkillRow> {
  assertExternalSkillsEnabled();
  const normalizedPackage = packageName.trim();
  const versionSeparator = normalizedPackage.lastIndexOf('@');
  const packageNameOnly =
    versionSeparator > 0 ? normalizedPackage.slice(0, versionSeparator) : normalizedPackage;
  const requestedVersion =
    versionSeparator > 0 ? normalizedPackage.slice(versionSeparator + 1) : undefined;
  const validPackageName = packageNameOnly.startsWith('@')
    ? /^@[a-z0-9._~-]+\/[a-z0-9._~-]+$/i.test(packageNameOnly)
    : /^[a-z0-9._~-]+$/i.test(packageNameOnly);
  const validVersion =
    requestedVersion === undefined ||
    requestedVersion === 'latest' ||
    /^\d+\.\d+\.\d+$/i.test(requestedVersion);
  if (!validPackageName || !validVersion) {
    throw new Error('npm install accepts only a package name with an optional exact version.');
  }
  const packagePath = path.join(process.cwd(), 'node_modules', packageNameOnly);

  // Install the package
  await execFile(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', normalizedPackage],
    {
      cwd: process.cwd(),
      timeout: 60_000,
    },
  );

  // Try to locate skill.json in the installed package
  const packageDir = packagePath;
  const manifestPath = path.join(packageDir, 'skill.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Package "${packageName}" installed, but no skill.json found at ${manifestPath}.`,
    );
  }

  const raw = fs.readFileSync(manifestPath, 'utf-8');
  const manifest = validateManifest(JSON.parse(raw));

  const handlerPath = manifest.handler
    ? resolvePackageHandlerPath(packageDir, manifest.handler)
    : undefined;

  const repo = await getSkillRepository();
  return repo.installSkill({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    category: manifest.category,
    version: manifest.version,
    functionName: manifest.functionName,
    source: 'npm',
    sourceUrl: packageName,
    toolDefinition: manifest.tool,
    handlerPath,
  });
}

// ── Manual ───────────────────────────────────────────────────────

async function installFromManifest(data: Record<string, unknown>): Promise<SkillRow> {
  const manifest = validateManifest(data);
  const repo = await getSkillRepository();
  return repo.installSkill({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    category: manifest.category,
    version: manifest.version,
    functionName: manifest.functionName,
    source: 'manual',
    toolDefinition: manifest.tool,
  });
}

// ── Public dispatcher ────────────────────────────────────────────

export async function installFromSource(source: string, value: unknown): Promise<SkillRow> {
  switch (source) {
    case 'github':
      if (typeof value !== 'string') throw new Error('GitHub install requires a URL string.');
      return installFromGitHub(value);

    case 'npm':
      if (typeof value !== 'string') throw new Error('npm install requires a package name string.');
      return installFromNpm(value);

    case 'manual':
      if (typeof value !== 'object' || !value)
        throw new Error('Manual install requires a manifest object.');
      return installFromManifest(value as Record<string, unknown>);

    default:
      throw new Error(`Unknown install source: "${source}". Use "github", "npm", or "manual".`);
  }
}
