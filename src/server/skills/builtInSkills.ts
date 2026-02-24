/**
 * Built-in skill definitions — seeded into the SQLite database on first run.
 *
 * These are the 9 real skills that ship with OpenClaw Gateway.
 * External skills installed via GitHub/npm are added at runtime.
 */

import type { SkillManifest } from '@/shared/toolSchema';

import browser from '@/skills/browser';
import filesystem from '@/skills/filesystem';
import gatewaySelfHeal from '@/skills/gateway-self-heal';
import github from '@/skills/github-manager';
import multiToolUseParallel from '@/skills/multi-tool-use-parallel';
import processManager from '@/skills/process-manager';
import python from '@/skills/python-runtime';
import search from '@/skills/search';
import shell from '@/skills/shell-access';
import sql from '@/skills/sql-bridge';
import subagents from '@/skills/subagents';
import vision from '@/skills/vision';

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
];
