import { browserSnapshotHandler } from './handlers/browserSnapshot';
import { dbQueryHandler } from './handlers/dbQuery';
import { fileReadHandler } from './handlers/fileRead';
import { githubQueryHandler } from './handlers/githubQuery';
import { pythonExecuteHandler } from './handlers/pythonExecute';
import { shellExecuteHandler } from './handlers/shellExecute';
import { visionAnalyzeHandler } from './handlers/visionAnalyze';

type SkillHandler = (args: Record<string, unknown>) => Promise<unknown>;

const SKILL_HANDLERS: Record<string, SkillHandler> = {
  file_read: fileReadHandler,
  shell_execute: shellExecuteHandler,
  python_execute: pythonExecuteHandler,
  github_query: githubQueryHandler,
  db_query: dbQueryHandler,
  browser_snapshot: browserSnapshotHandler,
  vision_analyze: visionAnalyzeHandler,
};

export function normalizeSkillArgs(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'object' && parsed ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export async function dispatchSkill(name: string, args: Record<string, unknown>) {
  const handler = SKILL_HANDLERS[name];
  if (!handler) {
    throw new Error(`Unsupported skill: ${name}`);
  }
  return handler(args);
}
