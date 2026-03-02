import { NextResponse } from 'next/server';
import { dispatchSkill, normalizeSkillArgs } from '@/server/skills/executeSkill';
import type { SkillDispatchContext } from '@/server/skills/types';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

interface SkillRequestContextInput {
  conversationId?: unknown;
  platform?: unknown;
  externalChatId?: unknown;
  workspaceCwd?: unknown;
}

interface SkillRequest {
  name: string;
  args?: unknown;
  context?: SkillRequestContextInput;
  conversationId?: unknown;
  platform?: unknown;
  externalChatId?: unknown;
  workspaceCwd?: unknown;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function resolveSkillDispatchContext(body: SkillRequest, userId: string): SkillDispatchContext {
  const context =
    body.context && typeof body.context === 'object'
      ? (body.context as Record<string, unknown>)
      : {
          conversationId: body.conversationId,
          platform: body.platform,
          externalChatId: body.externalChatId,
          workspaceCwd: body.workspaceCwd,
        };

  const conversationId = readOptionalString(context['conversationId']);
  const platform = readOptionalString(context['platform']) as SkillDispatchContext['platform'];
  const externalChatId = readOptionalString(context['externalChatId']);
  const workspaceCwd = readOptionalString(context['workspaceCwd']);

  return {
    userId,
    conversationId,
    platform,
    externalChatId,
    workspaceCwd,
  };
}

export const POST = withUserContext(async ({ request, userContext }) => {
  try {
    const body = (await request.json()) as SkillRequest;
    const context = resolveSkillDispatchContext(body, userContext.userId);
    const result = await dispatchSkill(body.name, normalizeSkillArgs(body.args), context);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown skill execution error';
    const status = String(message).startsWith('Unsupported skill:') ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
});
