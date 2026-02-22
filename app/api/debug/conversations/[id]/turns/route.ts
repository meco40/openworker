import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '@/server/auth/userContext';
import { getPromptDispatchRepository } from '@/server/stats/promptDispatchRepository';
import { getMessageRepository } from '@/server/channels/messages/runtime';
import type { DebugTurn } from '@/shared/domain/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await resolveRequestUserContext();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    // Application-layer join: two separate DBs — SQL join is not possible
    // 1. Fetch dispatch rows from stats DB
    const dispatches = getPromptDispatchRepository()
      .listDispatches({ conversationId: id, limit: 500 })
      .filter((d) => d.turnSeq != null)
      .sort((a, b) => (a.turnSeq ?? 0) - (b.turnSeq ?? 0));

    // 2. Fetch messages from messages DB
    const messages = getMessageRepository().listMessages(id, 500);
    const messagesBySeq = new Map(messages.filter((m) => m.seq != null).map((m) => [m.seq!, m]));

    // 3. Merge by seq
    const turns: DebugTurn[] = dispatches.map((dispatch) => {
      const userMsg = dispatch.turnSeq != null ? messagesBySeq.get(dispatch.turnSeq) : undefined;
      // Agent reply is typically the next message after the user message seq
      const agentMsg =
        dispatch.turnSeq != null ? messagesBySeq.get(dispatch.turnSeq + 1) : undefined;

      let toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      try {
        const parsed = JSON.parse(dispatch.toolCallsJson) as unknown;
        if (Array.isArray(parsed)) {
          toolCalls = parsed as typeof toolCalls;
        }
      } catch {
        // Ignore parse errors
      }

      return {
        seq: dispatch.turnSeq ?? 0,
        userPreview: userMsg ? userMsg.content.slice(0, 200) : dispatch.promptPreview.slice(0, 200),
        assistantPreview: agentMsg ? agentMsg.content.slice(0, 200) : '',
        modelName: dispatch.modelName,
        promptTokens: dispatch.promptTokens,
        completionTokens: dispatch.completionTokens,
        latencyMs: dispatch.latencyMs,
        toolCalls,
        memoryContext: dispatch.memoryContextJson,
        riskLevel: dispatch.riskLevel,
        dispatchId: dispatch.id,
      };
    });

    return NextResponse.json({ ok: true, turns });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
