import { normalizeArgs } from '../../shared/normalizeArgs';
import { browserSnapshotHandler } from './handlers/browserSnapshot';
import { dbQueryHandler } from './handlers/dbQuery';
import { fileReadHandler } from './handlers/fileRead';
import { githubQueryHandler } from './handlers/githubQuery';
import { pythonExecuteHandler } from './handlers/pythonExecute';
import { shellExecuteHandler } from './handlers/shellExecute';
import { visionAnalyzeHandler } from './handlers/visionAnalyze';

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
