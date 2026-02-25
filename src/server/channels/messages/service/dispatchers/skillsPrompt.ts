import type { BuiltInSkillSeed } from '@/server/skills/builtInSkills';
import type { SkillRow } from '@/server/skills/skillRepository';
import {
  buildSkillsPromptSection,
  enrichBuiltInManifest,
  type EnrichedSkill,
  type ParsedSkillMd,
  type SkillSource,
  userSkillToManifest,
} from '@/server/skills/skillMd/index';

interface BuildActiveSkillsPromptSectionParams {
  installedSkills: SkillRow[];
  eligibleParsedSkills: ParsedSkillMd[];
  builtInSeeds: BuiltInSkillSeed[];
}

export function buildActiveSkillsPromptSection(
  params: BuildActiveSkillsPromptSectionParams,
): string {
  const { installedSkills, eligibleParsedSkills, builtInSeeds } = params;
  if (installedSkills.length === 0) return '';

  const installedIds = new Set(installedSkills.map((skill) => skill.id));
  const builtInById = new Map(builtInSeeds.map((seed) => [seed.manifest.id, seed]));
  const enrichedById = new Map<string, EnrichedSkill>();

  for (const parsed of eligibleParsedSkills) {
    const skillId = parsed.frontmatter.id;
    if (!installedIds.has(skillId)) continue;

    if (parsed.tier === 'built-in') {
      const seed = builtInById.get(skillId);
      if (!seed) continue;
      enrichedById.set(skillId, enrichBuiltInManifest(seed.manifest, parsed));
      continue;
    }

    try {
      enrichedById.set(skillId, userSkillToManifest(parsed));
    } catch {
      // Keep runtime resilient: malformed user SKILL.md should not break chat dispatch.
    }
  }

  const orderedSkills = installedSkills.map((skill) => {
    return enrichedById.get(skill.id) ?? createFallbackSkill(skill);
  });

  return buildSkillsPromptSection(orderedSkills);
}

function createFallbackSkill(skill: SkillRow): EnrichedSkill {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    category: skill.category,
    functionName: skill.functionName,
    tool: skill.toolDefinition,
    body:
      `Active skill from registry (no SKILL.md guidance loaded).\n` +
      `Purpose: ${skill.description}`,
    filePath: '[generated-from-skill-registry]',
    source: mapSource(skill.source),
  };
}

function mapSource(source: SkillRow['source']): SkillSource {
  if (source === 'built-in') return 'bundled';
  return 'user';
}
