/**
 * Built-in skill definitions — seeded into the SQLite database on first run.
 *
 * Includes core native skills and optional compatibility aliases.
 * External skills installed via GitHub/npm are added at runtime.
 */

import type { SkillManifest } from '@/shared/toolSchema';

import agentsList from '@/skills/agents-list';
import applyPatch from '@/skills/apply-patch';
import browser from '@/skills/browser';
import browserTool from '@/skills/browser-tool';
import edit from '@/skills/edit';
import exec from '@/skills/exec';
import filesystem from '@/skills/filesystem';
import gatewaySelfHeal from '@/skills/gateway-self-heal';
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
import search from '@/skills/search';
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

export interface BuiltInSkillSeed {
  manifest: SkillManifest;
  installedByDefault: boolean;
}

export const BUILT_IN_SKILLS: BuiltInSkillSeed[] = [
  // Core Extensions
  { manifest: browser, installedByDefault: true },
  { manifest: search, installedByDefault: true },

  // Automation & Code
  { manifest: python, installedByDefault: true },
  { manifest: shell, installedByDefault: true },
  { manifest: playwrightCli, installedByDefault: true },
  { manifest: processManager, installedByDefault: true },
  { manifest: subagents, installedByDefault: true },
  { manifest: multiToolUseParallel, installedByDefault: true },
  { manifest: github, installedByDefault: false },

  // Data & Media
  { manifest: vision, installedByDefault: true },
  { manifest: sql, installedByDefault: false },

  // System
  { manifest: filesystem, installedByDefault: true },
  { manifest: gatewaySelfHeal, installedByDefault: false },

  // Web & Network
  { manifest: webSearch, installedByDefault: false },
  { manifest: webFetch, installedByDefault: true },
  { manifest: httpRequest, installedByDefault: false },

  // Output
  { manifest: notifications, installedByDefault: false },
  { manifest: pdfGenerate, installedByDefault: false },

  // Demo Compatibility (disabled by default to avoid extra tool overhead)
  { manifest: read, installedByDefault: false },
  { manifest: write, installedByDefault: false },
  { manifest: edit, installedByDefault: false },
  { manifest: applyPatch, installedByDefault: false },
  { manifest: exec, installedByDefault: false },
  { manifest: process, installedByDefault: false },
  { manifest: memorySearch, installedByDefault: false },
  { manifest: memoryGet, installedByDefault: false },
  { manifest: agentsList, installedByDefault: false },
  { manifest: sessionsList, installedByDefault: false },
  { manifest: sessionsHistory, installedByDefault: false },
  { manifest: sessionsSend, installedByDefault: false },
  { manifest: sessionsSpawn, installedByDefault: false },
  { manifest: sessionStatus, installedByDefault: false },
  { manifest: message, installedByDefault: false },
  { manifest: browserTool, installedByDefault: false },
];
