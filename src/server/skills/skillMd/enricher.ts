/**
 * Enricher — merges SKILL.md metadata with SkillManifest data.
 *
 * Tier-1 (built-in): the index.ts manifest is the source of truth for the
 * tool schema; SKILL.md only adds emoji and body.
 *
 * Tier-2 (user): the full manifest is derived from SKILL.md frontmatter.
 */

import type { SkillManifest, SkillToolDefinition, ToolDefinition } from '@/shared/toolSchema';

import type { ParsedSkillMd, UserSkillMdFrontmatter } from './types';

// ── Enriched skill ───────────────────────────────────────────────

export interface EnrichedSkill extends SkillManifest {
  emoji?: string;
  body: string;
  filePath: string;
  source: ParsedSkillMd['source'];
}

// ── Tier-1 ───────────────────────────────────────────────────────

/**
 * Merge a Tier-1 SKILL.md (additive metadata) with its index.ts manifest.
 * The tool schema from `manifest` is always preserved.
 */
export function enrichBuiltInManifest(
  manifest: SkillManifest,
  parsed: ParsedSkillMd,
): EnrichedSkill {
  const fm = parsed.frontmatter;
  return {
    ...manifest,
    emoji: 'emoji' in fm ? (fm.emoji as string | undefined) : undefined,
    body: parsed.body,
    filePath: parsed.filePath,
    source: parsed.source,
  };
}

// ── Tier-2 ───────────────────────────────────────────────────────

/**
 * Build a full EnrichedSkill from a Tier-2 SKILL.md (user/workspace skill).
 * Validates that the `tool:` block satisfies the ToolDefinition shape.
 */
export function userSkillToManifest(parsed: ParsedSkillMd): EnrichedSkill {
  if (parsed.tier !== 'user') {
    throw new Error(
      `userSkillToManifest called on a Tier-1 skill at "${parsed.filePath}". Use enrichBuiltInManifest instead.`,
    );
  }

  const fm = parsed.frontmatter as UserSkillMdFrontmatter;
  const toolDef = validateToolDefinition(fm.tool, parsed.filePath);

  return {
    id: fm.id,
    name: fm.name,
    description: fm.description,
    version: fm.version,
    category: fm.category,
    functionName: fm.functionName,
    tool: toolDef,
    emoji: fm.emoji,
    body: parsed.body,
    filePath: parsed.filePath,
    source: parsed.source,
  };
}

// ── Validation ───────────────────────────────────────────────────

function validateToolDefinition(raw: unknown, filePath: string): SkillToolDefinition {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`SKILL.md at "${filePath}": "tool" must be an object.`);
  }

  const obj = raw as Record<string, unknown>;

  // BuiltInToolDefinition: { builtIn: true, providerConfig: {...} }
  if ('builtIn' in obj && obj['builtIn'] === true) {
    if (typeof obj['providerConfig'] !== 'object' || obj['providerConfig'] === null) {
      throw new Error(
        `SKILL.md at "${filePath}": built-in tool definition requires a "providerConfig" object.`,
      );
    }
    return obj as unknown as SkillToolDefinition;
  }

  // Standard ToolDefinition: { name, description, parameters }
  if (typeof obj['name'] !== 'string' || !obj['name']) {
    throw new Error(`SKILL.md at "${filePath}": tool definition requires a non-empty "name".`);
  }
  if (typeof obj['description'] !== 'string' || !obj['description']) {
    throw new Error(
      `SKILL.md at "${filePath}": tool definition requires a non-empty "description".`,
    );
  }
  if (typeof obj['parameters'] !== 'object' || obj['parameters'] === null) {
    throw new Error(`SKILL.md at "${filePath}": tool definition requires a "parameters" object.`);
  }

  return obj as unknown as ToolDefinition;
}
