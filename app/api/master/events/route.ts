import { getServerEventBus } from '@/server/events/runtime';
import { isMasterOperatorEventsEnabled } from '@/server/master/featureFlags';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function encodeEvent(input: { id: string; event: string; data: unknown }): Uint8Array {
  return new TextEncoder().encode(
    `id: ${input.id}\nevent: ${input.event}\nretry: 5000\ndata: ${JSON.stringify(input.data)}\n\n`,
  );
}

export async function GET(request: Request) {
  if (!isMasterOperatorEventsEnabled()) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Master operator events are disabled.' }),
      {
        status: 404,
        headers: { 'content-type': 'application/json' },
      },
    );
  }

  const userId = await resolveMasterUserId();
  if (!userId) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  let interval: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const scope = resolveScopeFromRequest(request, userId);
      let closed = false;

      const emit = (event: string, data: Record<string, unknown>) => {
        if (closed) {
          return;
        }
        controller.enqueue(
          encodeEvent({
            id: String(data.id ?? Date.now()),
            event,
            data,
          }),
        );
      };

      emit('connected', {
        id: `${Date.now()}`,
        type: 'connected',
        at: new Date().toISOString(),
      });

      unsubscribe = getServerEventBus().subscribe('master.updated', (payload) => {
        if (payload.userId !== scope.userId || payload.workspaceId !== scope.workspaceId) {
          return;
        }
        emit('updated', {
          id: `${Date.now()}`,
          type: 'updated',
          at: payload.at,
          resources: payload.resources,
          runId: payload.runId ?? null,
          approvalRequestId: payload.approvalRequestId ?? null,
          sessionId: payload.sessionId ?? null,
          reminderId: payload.reminderId ?? null,
        });
      });

      interval = setInterval(() => {
        emit('heartbeat', {
          id: `${Date.now()}`,
          type: 'heartbeat',
          at: new Date().toISOString(),
        });
      }, 30_000);
      interval.unref?.();

      const cleanup = () => {
        if (closed) {
          return;
        }
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
      };

      request.signal.addEventListener('abort', cleanup, { once: true });
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': 'text/event-stream',
    },
  });
}
