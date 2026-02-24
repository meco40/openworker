/**
 * Public API for the SKILL.md metadata system.
 *
 * Everything consumers need is re-exported from this single entry point.
 */

export type {
  SkillSource,
  BuiltInSkillMdFrontmatter,
  UserSkillMdFrontmatter,
  SkillMdFrontmatter,
  ParsedSkillMd,
} from './types';
export { isUserSkillFrontmatter } from './types';

export { parseSkillMd } from './parser';

export type { LoadSkillsOptions } from './loader';
export { loadAllSkillMd, invalidateSkillMdCache } from './loader';

export type { EligibilityContext } from './filter';
export { filterEligibleSkills } from './filter';

export type { EnrichedSkill } from './enricher';
export { enrichBuiltInManifest, userSkillToManifest } from './enricher';

export { buildSkillsPromptSection } from './prompt';
