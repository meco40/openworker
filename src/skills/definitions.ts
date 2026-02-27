/**
 * Skill Tool Mapper — converts installed skills into provider-specific
 * tool definitions for the AI model context.
 */

import type { Skill } from '@/shared/domain/types';
import type { SkillToolDefinition } from '@/shared/toolSchema';
import { convertTools } from '@/shared/toolConverters';

import agentsList from '@/skills/agents-list';
import applyPatch from '@/skills/apply-patch';
import browser from '@/skills/browser';
import browserTool from '@/skills/browser-tool';
import edit from '@/skills/edit';
import exec from '@/skills/exec';
import python from '@/skills/python-runtime';
import search from '@/skills/search';
import vision from '@/skills/vision';
import filesystem from '@/skills/filesystem';
import github from '@/skills/github-manager';
import multiToolUseParallel from '@/skills/multi-tool-use-parallel';
import process from '@/skills/process';
import shell from '@/skills/shell-access';
import sql from '@/skills/sql-bridge';
import subagents from '@/skills/subagents';
import webSearch from '@/skills/web-search';
import webFetch from '@/skills/web-fetch';
import httpRequest from '@/skills/http-request';
import notifications from '@/skills/notifications';
import pdfGenerate from '@/skills/pdf-generate';
import playwrightCli from '@/skills/playwright-cli';
import read from '@/skills/read';
import write from '@/skills/write';
import memorySearch from '@/skills/memory-search';
import memoryGet from '@/skills/memory-get';
import sessionsList from '@/skills/sessions-list';
import sessionsHistory from '@/skills/sessions-history';
import sessionsSend from '@/skills/sessions-send';
import sessionsSpawn from '@/skills/sessions-spawn';
import sessionStatus from '@/skills/session-status';
import message from '@/skills/message';

interface SkillModule {
  id: string;
  tool: SkillToolDefinition;
}

const SKILL_MODULES: SkillModule[] = [
  browser,
  browserTool,
  python,
  search,
  vision,
  filesystem,
  read,
  write,
  edit,
  applyPatch,
  github,
  multiToolUseParallel,
  shell,
  exec,
  process,
  sql,
  subagents,
  memorySearch,
  memoryGet,
  agentsList,
  sessionsList,
  sessionsHistory,
  sessionsSend,
  sessionsSpawn,
  sessionStatus,
  message,
  webSearch,
  webFetch,
  httpRequest,
  notifications,
  pdfGenerate,
  playwrightCli,
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
