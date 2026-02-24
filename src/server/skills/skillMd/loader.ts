/**
 * Skill loader — discovers SKILL.md files from all configured sources and
 * merges them with a 10-second TTL cache.
 *
 * Sources (highest priority last, overrides same `id`):
 *   1. bundled  — src/skills/*\/SKILL.md  (ships with the app)
 *   2. user     — ~/.config/openclaw/skills/*\/SKILL.md
 *   3. workspace — {cwd}/skills/*\/SKILL.md
 *   4. env-override — $OPENCLAW_SKILLS_DIR/*\/SKILL.md
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { parseSkillMd } from './parser';
import type { ParsedSkillMd, SkillSource } from './types';

export interface LoadSkillsOptions {
  /** Absolute path to the current workspace (for workspace-scoped skills). */
  workspaceCwd?: string;
}

// ── Cache ────────────────────────────────────────────────────────

interface CacheEntry {
  skills: ParsedSkillMd[];
  expiresAt: number;
}

let _cache: CacheEntry | null = null;
let _cacheKey = '';
const TTL_MS = 10_000;

export function invalidateSkillMdCache(): void {
  _cache = null;
  _cacheKey = '';
}

// ── Directory resolution ─────────────────────────────────────────

/** Resolve the bundled skills directory (src/skills) relative to the project root. */
function resolveBundledSkillsDir(): string {
  // process.cwd() is the project root in both Next.js dev/build and test contexts.
  return path.join(process.cwd(), 'src', 'skills');
}

// ── Scan a directory ─────────────────────────────────────────────

/**
 * Scan `dir` for SKILL.md files in two patterns:
 *   - dir/SKILL.md          (flat)
 *   - dir/*\/SKILL.md        (one level deep)
 */
function loadSkillsFromDir(dir: string, source: SkillSource): ParsedSkillMd[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const results: ParsedSkillMd[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(entryPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      // Check for dir/<subdir>/SKILL.md
      const candidate = path.join(entryPath, 'SKILL.md');
      const parsed = tryParseSkillMd(candidate, source);
      if (parsed) results.push(parsed);
    } else if (entry === 'SKILL.md') {
      // Check for dir/SKILL.md (flat)
      const parsed = tryParseSkillMd(entryPath, source);
      if (parsed) results.push(parsed);
    }
  }

  return results;
}

function tryParseSkillMd(filePath: string, source: SkillSource): ParsedSkillMd | null {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    return parseSkillMd(content, filePath, source);
  } catch (err) {
    console.warn(`[skillMd] Skipping invalid SKILL.md at "${filePath}":`, err);
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Load all SKILL.md skills from all sources, deduplicated by `id` (higher
 * priority sources win) and cached for 10 seconds.
 */
export function loadAllSkillMd(opts?: LoadSkillsOptions): ParsedSkillMd[] {
  const bundledDir = resolveBundledSkillsDir();
  const userDir = path.join(homedir(), '.config', 'openclaw', 'skills');
  const wsDir = opts?.workspaceCwd ? path.join(opts.workspaceCwd, 'skills') : null;
  const envDir = process.env.OPENCLAW_SKILLS_DIR ?? null;

  const cacheKey = [bundledDir, userDir, wsDir ?? '', envDir ?? ''].join('|');

  const now = Date.now();
  if (_cache && _cacheKey === cacheKey && now < _cache.expiresAt) {
    return _cache.skills;
  }

  // Priority order: bundled < user < workspace < env-override
  const allSkills: [SkillSource, string][] = [
    ['bundled', bundledDir],
    ['user', userDir],
  ];
  if (wsDir) allSkills.push(['workspace', wsDir]);
  if (envDir) allSkills.push(['env-override', envDir]);

  const byId = new Map<string, ParsedSkillMd>();
  for (const [source, dir] of allSkills) {
    const batch = loadSkillsFromDir(dir, source);
    for (const skill of batch) {
      byId.set(skill.frontmatter.id, skill); // higher priority overwrites
    }
  }

  const skills = Array.from(byId.values());
  _cache = { skills, expiresAt: now + TTL_MS };
  _cacheKey = cacheKey;
  return skills;
}
