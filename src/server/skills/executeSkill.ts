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
import { webSearchHandler } from '@/server/skills/handlers/webSearch';
import { webFetchHandler } from '@/server/skills/handlers/webFetch';
import { httpRequestHandler } from '@/server/skills/handlers/httpRequest';
import { notificationsHandler } from '@/server/skills/handlers/notifications';
import { pdfGenerateHandler } from '@/server/skills/handlers/pdfGenerate';
import { playwrightCliHandler } from '@/server/skills/handlers/playwrightCli';
import { processManagerHandler } from '@/server/skills/handlers/processManager';
import { gatewaySelfHealHandler } from '@/server/skills/handlers/gatewaySelfHeal';
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
  multi_tool_use_parallel: multiToolUseParallelHandler,
  'multi_tool_use.parallel': multiToolUseParallelHandler,
  web_search: webSearchHandler,
  web_fetch: webFetchHandler,
  http_request: httpRequestHandler,
  notifications: notificationsHandler,
  pdf_generate: pdfGenerateHandler,
  playwright_cli: playwrightCliHandler,
  process_manager: processManagerHandler,
  gateway_self_heal: gatewaySelfHealHandler,
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
