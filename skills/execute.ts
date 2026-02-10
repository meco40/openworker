/**
 * Client-side skill execution dispatcher.
 *
 * When the AI model returns a FunctionCall, this module resolves which
 * skill module handles it and delegates to the server via the API.
 */

import { normalizeArgs } from '../src/shared/normalizeArgs';
import type { Skill } from '../types';

import browser from './browser';
import filesystem from './filesystem';
import github from './github-manager';
import python from './python-runtime';
import shell from './shell-access';
import sql from './sql-bridge';
import vision from './vision';

interface SkillModule {
  id: string;
  functionName: string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Map function names (as returned by AI models) → skill module id. */
const FUNCTION_TO_SKILL: Record<string, string> = {};

/** Map skill id → module with execute function. */
const MODULES: Record<string, SkillModule> = {};

// Register all built-in skill modules.
for (const mod of [browser, filesystem, github, python, shell, sql, vision] as SkillModule[]) {
  FUNCTION_TO_SKILL[mod.functionName] = mod.id;
  MODULES[mod.id] = mod;
}

/**
 * Execute a skill function call, verifying it is installed first.
 */
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
