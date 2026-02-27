/**
 * Client-side skill execution dispatcher.
 *
 * When the AI model returns a FunctionCall, this module resolves which
 * skill module handles it and delegates to the server via the API.
 */

import { normalizeArgs } from '@/shared/normalizeArgs';
import type { Skill } from '@/shared/domain/types';

import agentsList from '@/skills/agents-list';
import applyPatch from '@/skills/apply-patch';
import browser from '@/skills/browser';
import browserTool from '@/skills/browser-tool';
import edit from '@/skills/edit';
import exec from '@/skills/exec';
import filesystem from '@/skills/filesystem';
import github from '@/skills/github-manager';
import httpRequest from '@/skills/http-request';
import memoryGet from '@/skills/memory-get';
import memorySearch from '@/skills/memory-search';
import message from '@/skills/message';
import multiToolUseParallel from '@/skills/multi-tool-use-parallel';
import notifications from '@/skills/notifications';
import pdfGenerate from '@/skills/pdf-generate';
import playwrightCli from '@/skills/playwright-cli';
import process from '@/skills/process';
import processManager from '@/skills/process-manager';
import python from '@/skills/python-runtime';
import read from '@/skills/read';
import sessionStatus from '@/skills/session-status';
import shell from '@/skills/shell-access';
import sql from '@/skills/sql-bridge';
import subagents from '@/skills/subagents';
import sessionsHistory from '@/skills/sessions-history';
import sessionsList from '@/skills/sessions-list';
import sessionsSend from '@/skills/sessions-send';
import sessionsSpawn from '@/skills/sessions-spawn';
import vision from '@/skills/vision';
import webFetch from '@/skills/web-fetch';
import webSearch from '@/skills/web-search';
import write from '@/skills/write';

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
for (const mod of [
  agentsList,
  applyPatch,
  browser,
  browserTool,
  edit,
  exec,
  filesystem,
  github,
  httpRequest,
  memoryGet,
  memorySearch,
  message,
  multiToolUseParallel,
  notifications,
  pdfGenerate,
  playwrightCli,
  process,
  processManager,
  python,
  read,
  sessionStatus,
  shell,
  sql,
  subagents,
  sessionsHistory,
  sessionsList,
  sessionsSend,
  sessionsSpawn,
  vision,
  webFetch,
  webSearch,
  write,
] as SkillModule[]) {
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
