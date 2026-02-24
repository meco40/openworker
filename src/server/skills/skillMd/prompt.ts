/**
 * Builds the system-prompt section that injects skill guidance into the LLM
 * context from enriched SKILL.md bodies.
 *
 * Applies a 30 000-character soft cap using binary search to include as many
 * skills as possible without exceeding the limit.
 */

import type { EnrichedSkill } from './enricher';

const MAX_CHARS = 30_000;
const SECTION_HEADER = '## Skill Guidance\n\n';
const DIVIDER = '---\n\n';

/**
 * Build the skills prompt section from a list of enriched skills.
 *
 * Only skills with a non-empty `body` are included. Returns an empty string
 * if no skills have guidance bodies, so callers can skip the unshift.
 */
export function buildSkillsPromptSection(skills: EnrichedSkill[]): string {
  const withBody = skills.filter((s) => s.body.trim().length > 0);
  if (withBody.length === 0) return '';

  const blocks = withBody.map((s) => formatSkillBlock(s));

  // Attempt to fit all blocks; if over the cap, binary-search the prefix.
  const full = SECTION_HEADER + blocks.join('');
  if (full.length <= MAX_CHARS) return full;

  // Binary search: find the largest N such that the prefix fits.
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = SECTION_HEADER + blocks.slice(0, mid + 1).join('');
    if (candidate.length <= MAX_CHARS) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  if (lo < 0) return '';
  const prefix = SECTION_HEADER + blocks.slice(0, lo + 1).join('');
  return prefix.length <= MAX_CHARS ? prefix : '';
}

function formatSkillBlock(skill: EnrichedSkill): string {
  const emoji = skill.emoji ? `${skill.emoji} ` : '';
  const header = `### ${emoji}${skill.name} (\`${skill.functionName}\`)\n`;
  return `${header}\n${skill.body}\n\n${DIVIDER}`;
}
