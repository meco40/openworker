import { normalizeArgs } from '@/shared/normalizeArgs';
import { browserSnapshotHandler } from '@/server/skills/handlers/browserSnapshot';
import { dbQueryHandler } from '@/server/skills/handlers/dbQuery';
import { fileReadHandler } from '@/server/skills/handlers/fileRead';
import { githubQueryHandler } from '@/server/skills/handlers/githubQuery';
import { multiToolUseParallelHandler } from '@/server/skills/handlers/multiToolUseParallel';
import { pythonExecuteHandler } from '@/server/skills/handlers/pythonExecute';
import { shellExecuteHandler } from '@/server/skills/handlers/shellExecute';
import { subagentsHandler } from '@/server/skills/handlers/subagents';
import { visionAnalyzeHandler } from '@/server/skills/handlers/visionAnalyze';
import type { SkillDispatchContext, SkillHandler } from '@/server/skills/types';

export { normalizeArgs as normalizeSkillArgs };
export type { SkillDispatchContext } from '@/server/skills/types';

const SKILL_HANDLERS: Record<string, SkillHandler> = {
  file_read: fileReadHandler,
  shell_execute: shellExecuteHandler,
  python_execute: pythonExecuteHandler,
  github_query: githubQueryHandler,
  db_query: dbQueryHandler,
  browser_snapshot: browserSnapshotHandler,
  vision_analyze: visionAnalyzeHandler,
  subagents: subagentsHandler,
  'multi_tool_use.parallel': multiToolUseParallelHandler,
};

export async function dispatchSkill(
  name: string,
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
) {
  const handler = SKILL_HANDLERS[name];
  if (!handler) {
    throw new Error(`Unsupported skill: ${name}`);
  }
  return handler(args, context);
}
