/**
 * Eligibility filter for SKILL.md skills.
 *
 * Checks OS platform, environment variables, and required binaries before
 * a skill is surfaced to the LLM.
 */

import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

import type { ParsedSkillMd } from './types';

export interface EligibilityContext {
  /** Override process.platform for testing. */
  platform?: string;
}

/**
 * Return only the skills that are eligible in the current environment.
 *
 * Priority rules:
 * - `always: true` → always included, skips all other checks.
 * - `os[]` → must include current platform.
 * - `requires.env[]` → ALL must be non-empty in process.env.
 * - `requires.bins[]` → ALL must be found in PATH.
 * - `requires.anyBins[]` → at least ONE must be found in PATH.
 */
export function filterEligibleSkills(
  skills: ParsedSkillMd[],
  ctx?: EligibilityContext,
): ParsedSkillMd[] {
  const platform = ctx?.platform ?? process.platform;
  return skills.filter((s) => isEligible(s, platform));
}

function isEligible(skill: ParsedSkillMd, platform: string): boolean {
  const fm = skill.frontmatter;

  // `always: true` bypasses all other checks.
  if ('always' in fm && fm.always === true) return true;

  // OS check.
  if ('os' in fm && Array.isArray(fm.os) && fm.os.length > 0) {
    if (!(fm.os as string[]).includes(platform)) return false;
  }

  if (!('requires' in fm) || fm.requires == null) return true;

  const req = fm.requires as {
    env?: string[];
    bins?: string[];
    anyBins?: string[];
  };

  // All env vars must be present and non-empty.
  if (Array.isArray(req.env)) {
    for (const envVar of req.env) {
      if (!process.env[envVar]) return false;
    }
  }

  // All required binaries must be in PATH.
  if (Array.isArray(req.bins)) {
    for (const bin of req.bins) {
      if (!isBinAvailable(bin)) return false;
    }
  }

  // At least one of anyBins must be in PATH.
  if (Array.isArray(req.anyBins) && req.anyBins.length > 0) {
    if (!req.anyBins.some((bin) => isBinAvailable(bin))) return false;
  }

  return true;
}

/** Cache to avoid repeated PATH scans per process lifetime. */
const binCache = new Map<string, boolean>();

function isBinAvailable(bin: string): boolean {
  if (binCache.has(bin)) return binCache.get(bin)!;

  const found = checkBin(bin);
  binCache.set(bin, found);
  return found;
}

function checkBin(bin: string): boolean {
  // On Windows, also try common executable extensions.
  const candidates =
    process.platform === 'win32' ? [bin, `${bin}.exe`, `${bin}.cmd`, `${bin}.bat`] : [bin];

  for (const candidate of candidates) {
    try {
      const which = process.platform === 'win32' ? 'where' : 'which';
      execFileSync(which, [candidate], { stdio: 'ignore' });
      return true;
    } catch {
      // Not found with this candidate.
    }
  }

  // Fallback: check PATH directories manually.
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of pathDirs) {
    for (const candidate of candidates) {
      try {
        accessSync(path.join(dir, candidate), constants.X_OK);
        return true;
      } catch {
        // Not found here.
      }
    }
  }

  return false;
}
