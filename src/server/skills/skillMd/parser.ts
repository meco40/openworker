/**
 * SKILL.md frontmatter parser.
 *
 * Extracts the YAML frontmatter block (between `---` delimiters) and the
 * markdown body, validates required fields, and returns a typed ParsedSkillMd.
 *
 * Uses the `yaml` package (same as the OpenClaw demo) for reliable YAML
 * parsing with a JSON-compatible schema.
 */

import YAML from 'yaml';

import type {
  ParsedSkillMd,
  SkillMdFrontmatter,
  SkillSource,
  UserSkillMdFrontmatter,
} from './types';

/** Matches a YAML frontmatter block at the start of a file. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const REQUIRED_USER_FIELDS: Array<keyof UserSkillMdFrontmatter> = [
  'id',
  'name',
  'description',
  'version',
  'category',
  'functionName',
  'tool',
];

/**
 * Parse a SKILL.md file's text content into a structured ParsedSkillMd.
 *
 * @throws {Error} when frontmatter is missing, `id` is absent, or a Tier-2
 *   file is missing required fields.
 */
export function parseSkillMd(
  content: string,
  filePath: string,
  source: SkillSource,
): ParsedSkillMd {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    throw new Error(
      `SKILL.md at "${filePath}" is missing a YAML frontmatter block (expected opening and closing ---).`,
    );
  }

  const yamlBlock = match[1];
  const body = content.slice(match[0].length).trim();

  let raw: unknown;
  try {
    raw = YAML.parse(yamlBlock, { schema: 'core' });
  } catch (err) {
    throw new Error(
      `SKILL.md at "${filePath}" has invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`SKILL.md at "${filePath}" frontmatter must be a YAML mapping.`);
  }

  const fm = raw as Record<string, unknown>;

  if (!fm['id'] || typeof fm['id'] !== 'string') {
    throw new Error(`SKILL.md at "${filePath}" frontmatter is missing a required string "id".`);
  }

  // Determine tier by presence of `tool:` field.
  const isUser = 'tool' in fm;

  if (isUser) {
    // Tier-2: validate all required fields are present.
    const missing = REQUIRED_USER_FIELDS.filter((k) => !(k in fm));
    if (missing.length > 0) {
      throw new Error(
        `SKILL.md at "${filePath}" is a Tier-2 (user) skill but is missing required fields: ${missing.join(', ')}.`,
      );
    }
  }

  return {
    tier: isUser ? 'user' : 'built-in',
    frontmatter: fm as unknown as SkillMdFrontmatter,
    body,
    filePath,
    source,
  };
}
