import { normalizeArgs } from '../../shared/normalizeArgs';
import { browserSnapshotHandler } from './handlers/browserSnapshot.ts';
import { dbQueryHandler } from './handlers/dbQuery.ts';
import { fileReadHandler } from './handlers/fileRead.ts';
import { githubQueryHandler } from './handlers/githubQuery.ts';
import { pythonExecuteHandler } from './handlers/pythonExecute.ts';
import { shellExecuteHandler } from './handlers/shellExecute.ts';
import { visionAnalyzeHandler } from './handlers/visionAnalyze.ts';

export { normalizeArgs as normalizeSkillArgs };

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

export async function dispatchSkill(name: string, args: Record<string, unknown>) {
  const handler = SKILL_HANDLERS[name];
  if (!handler) {
    throw new Error(`Unsupported skill: ${name}`);
  }
  return handler(args);
}
