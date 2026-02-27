import { normalizeArgs } from '@/shared/normalizeArgs';
import { browserSnapshotHandler } from '@/server/skills/handlers/browserSnapshot';
import { browserToolHandler } from '@/server/skills/handlers/browserTool';
import {
  applyPatchCompatHandler,
  editCompatHandler,
  readCompatHandler,
  writeCompatHandler,
} from '@/server/skills/handlers/codingCompat';
import { dbQueryHandler } from '@/server/skills/handlers/dbQuery';
import { fileReadHandler } from '@/server/skills/handlers/fileRead';
import { githubQueryHandler } from '@/server/skills/handlers/githubQuery';
import { multiToolUseParallelHandler } from '@/server/skills/handlers/multiToolUseParallel';
import { memoryGetHandler, memorySearchHandler } from '@/server/skills/handlers/memoryCompat';
import { messageCompatHandler } from '@/server/skills/handlers/messageCompat';
import {
  agentsListHandler,
  sessionStatusHandler,
  sessionsHistoryHandler,
  sessionsListHandler,
  sessionsSendHandler,
  sessionsSpawnHandler,
} from '@/server/skills/handlers/sessionCompat';
import { pythonExecuteHandler } from '@/server/skills/handlers/pythonExecute';
import { shellExecuteHandler } from '@/server/skills/handlers/shellExecute';
import { subagentsHandler } from '@/server/skills/handlers/subagents';
import { visionAnalyzeHandler } from '@/server/skills/handlers/visionAnalyze';
import { webSearchHandler } from '@/server/skills/handlers/webSearch';
import { webFetchHandler } from '@/server/skills/handlers/webFetch';
import { httpRequestHandler } from '@/server/skills/handlers/httpRequest';
import { notificationsHandler } from '@/server/skills/handlers/notifications';
import { pdfGenerateHandler } from '@/server/skills/handlers/pdfGenerate';
import { playwrightCliHandler } from '@/server/skills/handlers/playwrightCli';
import { processManagerHandler } from '@/server/skills/handlers/processManager';
import { gatewaySelfHealHandler } from '@/server/skills/handlers/gatewaySelfHeal';
import { executeExternalSkillInHost } from '@/server/skills/externalSkillHost';
import { getSkillRepository } from '@/server/skills/skillRepository';
import type { SkillDispatchContext, SkillHandler } from '@/server/skills/types';

export { normalizeArgs as normalizeSkillArgs };
export type { SkillDispatchContext } from '@/server/skills/types';

const SKILL_HANDLERS: Partial<Record<string, SkillHandler>> = {
  file_read: fileReadHandler,
  read: readCompatHandler,
  write: writeCompatHandler,
  edit: editCompatHandler,
  apply_patch: applyPatchCompatHandler,
  shell_execute: shellExecuteHandler,
  exec: shellExecuteHandler,
  python_execute: pythonExecuteHandler,
  github_query: githubQueryHandler,
  db_query: dbQueryHandler,
  browser_snapshot: browserSnapshotHandler,
  browser: browserToolHandler,
  vision_analyze: visionAnalyzeHandler,
  subagents: subagentsHandler,
  agents_list: agentsListHandler,
  sessions_list: sessionsListHandler,
  sessions_history: sessionsHistoryHandler,
  sessions_send: sessionsSendHandler,
  sessions_spawn: sessionsSpawnHandler,
  session_status: sessionStatusHandler,
  message: messageCompatHandler,
  memory_search: memorySearchHandler,
  memory_get: memoryGetHandler,
  multi_tool_use_parallel: multiToolUseParallelHandler,
  'multi_tool_use.parallel': multiToolUseParallelHandler,
  web_search: webSearchHandler,
  web_fetch: webFetchHandler,
  http_request: httpRequestHandler,
  notifications: notificationsHandler,
  pdf_generate: pdfGenerateHandler,
  playwright_cli: playwrightCliHandler,
  process_manager: processManagerHandler,
  process: processManagerHandler,
  gateway_self_heal: gatewaySelfHealHandler,
};

function toExternalDispatchContext(
  context?: SkillDispatchContext,
): SkillDispatchContext | undefined {
  if (!context) return undefined;
  return {
    bypassApproval: context.bypassApproval,
    workspaceCwd: context.workspaceCwd,
    conversationId: context.conversationId,
    userId: context.userId,
    platform: context.platform,
    externalChatId: context.externalChatId,
  };
}

async function dispatchExternalSkill(
  functionName: string,
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
): Promise<unknown | null> {
  const repo = await getSkillRepository();
  const skillRow = repo
    .listSkills()
    .find(
      (row) =>
        row.installed &&
        row.functionName === functionName &&
        row.source !== 'built-in' &&
        Boolean(row.handlerPath),
    );

  if (!skillRow?.handlerPath) {
    return null;
  }

  return executeExternalSkillInHost({
    functionName,
    handlerPath: skillRow.handlerPath,
    args,
    context: toExternalDispatchContext(context),
  });
}

export async function dispatchSkill(
  name: string,
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
) {
  const handler = SKILL_HANDLERS[name];
  if (!handler) {
    const externalResult = await dispatchExternalSkill(name, args, context);
    if (externalResult !== null) {
      return externalResult;
    }
    throw new Error(`Unsupported skill: ${name}`);
  }
  return handler(args, context);
}
