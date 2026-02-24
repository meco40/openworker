/**
 * Type definitions for the SKILL.md metadata system.
 *
 * Two tiers:
 *   - Tier-1 (built-in): SKILL.md is additive only (emoji, os, requires, body).
 *     The tool schema comes from the TypeScript index.ts (browser-safe).
 *   - Tier-2 (user/workspace): Standalone SKILL.md with a full `tool:` YAML block.
 *     No TypeScript required.
 */

// ── Source ───────────────────────────────────────────────────────

export type SkillSource = 'bundled' | 'user' | 'workspace' | 'env-override';

// ── Frontmatter shapes ───────────────────────────────────────────

interface SkillRequires {
  /** Environment variable names — ALL must be present. */
  env?: string[];
  /** Binary names — ALL must be in PATH. */
  bins?: string[];
  /** Binary names — at least ONE must be in PATH. */
  anyBins?: string[];
}

/**
 * Frontmatter for a Tier-1 (built-in) SKILL.md.
 * Must NOT have a `tool:` field — schema comes from index.ts.
 */
export interface BuiltInSkillMdFrontmatter {
  id: string;
  emoji?: string;
  /** Allowed platforms ('darwin' | 'linux' | 'win32'). Omit = all platforms. */
  os?: string[];
  /** If true: always included regardless of OS/requires checks. */
  always?: boolean;
  requires?: SkillRequires;
}

/**
 * Frontmatter for a Tier-2 (user/workspace) SKILL.md.
 * MUST have a `tool:` field with the full JSON Schema tool definition.
 */
export interface UserSkillMdFrontmatter {
  id: string;
  name: string;
  description: string;
  version: string;
  category: string;
  functionName: string;
  installedByDefault?: boolean;
  emoji?: string;
  os?: string[];
  always?: boolean;
  requires?: SkillRequires;
  /** Full ToolDefinition or BuiltInToolDefinition in YAML. */
  tool: unknown;
}

export type SkillMdFrontmatter = BuiltInSkillMdFrontmatter | UserSkillMdFrontmatter;

export function isUserSkillFrontmatter(f: SkillMdFrontmatter): f is UserSkillMdFrontmatter {
  return 'tool' in f;
}

// ── Parsed result ────────────────────────────────────────────────

export interface ParsedSkillMd {
  /** 'built-in' when no `tool:` in frontmatter; 'user' when tool: present. */
  tier: 'built-in' | 'user';
  frontmatter: SkillMdFrontmatter;
  /** Markdown body (everything after the closing `---`). */
  body: string;
  filePath: string;
  source: SkillSource;
}
