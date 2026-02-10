import browser from './browser';
import filesystem from './filesystem';
import github from './github-manager';
import python from './python-runtime';
import shell from './shell-access';
import sql from './sql-bridge';
import vision from './vision';
import type { Skill } from '../types';

const FUNCTION_TO_SKILL: Record<string, string> = {
  browser_snapshot: 'browser',
  file_read: 'filesystem',
  github_query: 'github-manager',
  python_execute: 'python-runtime',
  shell_execute: 'shell-access',
  db_query: 'sql-bridge',
  vision_analyze: 'vision',
};

interface SkillModule {
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

const MODULES: Record<string, SkillModule> = {
  browser: browser as unknown as SkillModule,
  filesystem: filesystem as unknown as SkillModule,
  'github-manager': github as unknown as SkillModule,
  'python-runtime': python as unknown as SkillModule,
  'shell-access': shell as unknown as SkillModule,
  'sql-bridge': sql as unknown as SkillModule,
  vision: vision as unknown as SkillModule,
};

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      return typeof parsed === 'object' && parsed ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof args === 'object' ? (args as Record<string, unknown>) : {};
}

export async function executeSkillFunctionCall(
  functionName: string,
  args: unknown,
  skills: Skill[],
): Promise<unknown> {
  const skillId = FUNCTION_TO_SKILL[functionName];
  if (!skillId) return null;

  const installed = skills.some((skill) => skill.id === skillId && skill.installed);
  if (!installed) {
    throw new Error(`Skill "${skillId}" is not installed.`);
  }

  const skillModule = MODULES[skillId];
  if (!skillModule) {
    throw new Error(`Missing module for skill "${skillId}".`);
  }

  return skillModule.execute(normalizeArgs(args));
}
