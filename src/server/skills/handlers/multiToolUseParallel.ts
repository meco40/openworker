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
import { memoryGetHandler, memorySearchHandler } from '@/server/skills/handlers/memoryCompat';
import { messageCompatHandler } from '@/server/skills/handlers/messageCompat';
import { pythonExecuteHandler } from '@/server/skills/handlers/pythonExecute';
import { playwrightCliHandler } from '@/server/skills/handlers/playwrightCli';
import { processManagerHandler } from '@/server/skills/handlers/processManager';
import {
  agentsListHandler,
  sessionStatusHandler,
  sessionsHistoryHandler,
  sessionsListHandler,
  sessionsSendHandler,
  sessionsSpawnHandler,
} from '@/server/skills/handlers/sessionCompat';
import { shellExecuteHandler } from '@/server/skills/handlers/shellExecute';
import { subagentsHandler } from '@/server/skills/handlers/subagents';
import { visionAnalyzeHandler } from '@/server/skills/handlers/visionAnalyze';
import type { SkillDispatchContext } from '@/server/skills/types';

type ParallelToolCallInput = {
  name?: unknown;
  recipient_name?: unknown;
  args?: unknown;
  parameters?: unknown;
};

const PARALLEL_SKILL_NAME = 'multi_tool_use_parallel';
const LEGACY_PARALLEL_SKILL_NAME = 'multi_tool_use.parallel';

const SUPPORTED_PARALLEL_HANDLERS: Record<
  string,
  (args: Record<string, unknown>, context?: SkillDispatchContext) => Promise<unknown>
> = {
  shell_execute: shellExecuteHandler,
  exec: shellExecuteHandler,
  file_read: fileReadHandler,
  read: readCompatHandler,
  write: writeCompatHandler,
  edit: editCompatHandler,
  apply_patch: applyPatchCompatHandler,
  python_execute: pythonExecuteHandler,
  playwright_cli: playwrightCliHandler,
  browser_snapshot: browserSnapshotHandler,
  browser: browserToolHandler,
  vision_analyze: visionAnalyzeHandler,
  db_query: dbQueryHandler,
  github_query: githubQueryHandler,
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
  process_manager: processManagerHandler,
  process: processManagerHandler,
};

function normalizeCallName(input: ParallelToolCallInput): string {
  const explicit = String(input.name || '').trim();
  if (explicit) return explicit;

  const recipient = String(input.recipient_name || '').trim();
  if (!recipient) return '';
  return recipient.startsWith('functions.') ? recipient.slice('functions.'.length) : recipient;
}

function normalizeCallArgs(input: ParallelToolCallInput): Record<string, unknown> {
  const raw = input.parameters ?? input.args ?? {};
  return normalizeArgs(raw);
}

export async function multiToolUseParallelHandler(
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
) {
  const toolUsesRaw = args.tool_uses;
  if (!Array.isArray(toolUsesRaw) || toolUsesRaw.length === 0) {
    throw new Error('multi_tool_use.parallel requires a non-empty tool_uses array.');
  }

  const calls = toolUsesRaw as ParallelToolCallInput[];
  const results = await Promise.all(
    calls.map(async (call, index) => {
      const name = normalizeCallName(call);
      const callArgs = normalizeCallArgs(call);

      if (!name) {
        return {
          index,
          name: '',
          ok: false,
          error: 'Tool call is missing name/recipient_name.',
        };
      }

      if (name === PARALLEL_SKILL_NAME || name === LEGACY_PARALLEL_SKILL_NAME) {
        return {
          index,
          name,
          ok: false,
          error: 'Nested multi_tool_use.parallel calls are not allowed.',
        };
      }

      const handler = SUPPORTED_PARALLEL_HANDLERS[name];
      if (!handler) {
        return {
          index,
          name,
          ok: false,
          error: `Unsupported parallel tool: ${name}`,
        };
      }

      try {
        const value = await handler(callArgs, context);
        return {
          index,
          name,
          ok: true,
          result: value,
        };
      } catch (error) {
        return {
          index,
          name,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const successCount = results.filter((item) => item.ok).length;
  const failureCount = results.length - successCount;

  return {
    status: failureCount === 0 ? 'ok' : successCount === 0 ? 'error' : 'partial',
    successCount,
    failureCount,
    results,
  };
}
