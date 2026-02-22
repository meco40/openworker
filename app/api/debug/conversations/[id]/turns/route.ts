import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '@/server/auth/userContext';
import { getPromptDispatchRepository } from '@/server/stats/promptDispatchRepository';
import { getMessageRepository } from '@/server/channels/messages/runtime';
import type { DebugTurn } from '@/shared/domain/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await resolveRequestUserContext();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(200, parsePositiveInt(url.searchParams.get('limit'), 50)));
  const beforeSeqRaw = parsePositiveInt(url.searchParams.get('beforeSeq'), 0);
  const beforeSeq = beforeSeqRaw > 0 ? beforeSeqRaw : undefined;

  try {
    // Application-layer join: two separate DBs — SQL join is not possible
    // 1. Fetch paginated dispatch rows from stats DB
    const dispatches = getPromptDispatchRepository()
      .listDispatches({
        conversationId: id,
        limit: limit + 1,
        beforeTurnSeq: beforeSeq,
      })
      .filter((d) => d.turnSeq != null)
      .sort((a, b) => (b.turnSeq ?? 0) - (a.turnSeq ?? 0));
    const hasMore = dispatches.length > limit;
    const pageDispatches = hasMore ? dispatches.slice(0, limit) : dispatches;
    const nextBeforeSeq = hasMore ? (pageDispatches.at(-1)?.turnSeq ?? null) : null;

    // 2. Fetch messages from messages DB
    let messages = [] as ReturnType<ReturnType<typeof getMessageRepository>['listMessages']>;
    const messageRepository = getMessageRepository();
    const minSeq = pageDispatches.reduce(
      (min, dispatch) => Math.min(min, dispatch.turnSeq ?? Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER,
    );
    const maxSeq = pageDispatches.reduce(
      (max, dispatch) => Math.max(max, dispatch.turnSeq ?? 0),
      0,
    );
    const pageSpan = minSeq <= maxSeq ? maxSeq - minSeq + 2 : 0;
    const pageMessageLimit = Math.max(50, Math.min(1000, pageSpan + 10));
    if (pageDispatches.length > 0 && typeof messageRepository.listMessagesAfterSeq === 'function') {
      messages = messageRepository.listMessagesAfterSeq(
        id,
        Math.max(0, minSeq - 1),
        pageMessageLimit,
      );
    } else {
      messages = messageRepository.listMessages(id, Math.max(500, limit * 3));
    }
    const messagesBySeq = new Map(messages.filter((m) => m.seq != null).map((m) => [m.seq!, m]));

    // 3. Merge by seq
    const turns: DebugTurn[] = pageDispatches
      .map((dispatch) => {
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
          userPreview: userMsg
            ? userMsg.content.slice(0, 200)
            : dispatch.promptPreview.slice(0, 200),
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
      })
      .sort((a, b) => a.seq - b.seq);

    return NextResponse.json({
      ok: true,
      turns,
      pagination: {
        limit,
        returned: turns.length,
        hasMore,
        nextBeforeSeq,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
