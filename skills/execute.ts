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

const MODULES: Record<string, { execute: (args: Record<string, unknown>) => Promise<unknown> }> = {
  browser,
  filesystem,
  'github-manager': github,
  'python-runtime': python,
  'shell-access': shell,
  'sql-bridge': sql,
  vision,
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

  const module = MODULES[skillId];
  if (!module) {
    throw new Error(`Missing module for skill "${skillId}".`);
  }

  return module.execute(normalizeArgs(args));
}
