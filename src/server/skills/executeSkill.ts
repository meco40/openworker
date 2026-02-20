import { normalizeArgs } from '../../shared/normalizeArgs';
import { ChannelType } from '../../../types';
import { browserSnapshotHandler } from './handlers/browserSnapshot';
import { dbQueryHandler } from './handlers/dbQuery';
import { fileReadHandler } from './handlers/fileRead';
import { githubQueryHandler } from './handlers/githubQuery';
import { pythonExecuteHandler } from './handlers/pythonExecute';
import { shellExecuteHandler } from './handlers/shellExecute';
import { subagentsHandler } from './handlers/subagents';
import { visionAnalyzeHandler } from './handlers/visionAnalyze';

export { normalizeArgs as normalizeSkillArgs };

export interface SkillDispatchContext {
  bypassApproval?: boolean;
  conversationId?: string;
  userId?: string;
  platform?: ChannelType;
  externalChatId?: string;
}

type SkillHandler = (
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
) => Promise<unknown>;

const SKILL_HANDLERS: Record<string, SkillHandler> = {
  file_read: fileReadHandler,
  shell_execute: shellExecuteHandler,
  python_execute: pythonExecuteHandler,
  github_query: githubQueryHandler,
  db_query: dbQueryHandler,
  browser_snapshot: browserSnapshotHandler,
  vision_analyze: visionAnalyzeHandler,
  subagents: subagentsHandler,
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
