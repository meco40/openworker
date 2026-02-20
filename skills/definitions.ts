/**
 * Skill Tool Mapper — converts installed skills into provider-specific
 * tool definitions for the AI model context.
 */

import type { Skill } from '../types';
import type { SkillToolDefinition } from '../src/shared/toolSchema';
import { convertTools } from '../src/shared/toolConverters';

import browser from './browser';
import python from './python-runtime';
import search from './search';
import vision from './vision';
import filesystem from './filesystem';
import github from './github-manager';
import shell from './shell-access';
import sql from './sql-bridge';
import subagents from './subagents';

interface SkillModule {
  id: string;
  tool: SkillToolDefinition;
}

const SKILL_MODULES: SkillModule[] = [
  browser,
  python,
  search,
  vision,
  filesystem,
  github,
  shell,
  sql,
  subagents,
];

/**
 * Build the tool array for the given provider from currently installed skills.
 *
 * @param skills — current skill list (with installed flags)
 * @param provider — target AI provider ('gemini' | 'openai' | 'claude')
 */
export function mapSkillsToTools(skills: Skill[], provider: string = 'gemini'): unknown[] {
  const installedIds = new Set(skills.filter((s) => s.installed).map((s) => s.id));

  const toolDefs: SkillToolDefinition[] = SKILL_MODULES.filter((m) => installedIds.has(m.id)).map(
    (m) => m.tool,
  );

  return convertTools(toolDefs, provider);
}
