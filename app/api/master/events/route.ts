import { getMasterRepository } from '@/server/master/runtime';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';
import { isMasterOperatorEventsEnabled } from '@/server/master/featureFlags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function buildSnapshot(scope: { userId: string; workspaceId: string }) {
  const repo = getMasterRepository();
  const pendingApprovals = repo
    .listApprovalRequests(scope, undefined, 500)
    .filter((request) => request.status === 'pending').length;
  const activeRuns = repo
    .listRuns(scope, 500)
    .filter((run) =>
      ['ANALYZING', 'PLANNING', 'DELEGATING', 'EXECUTING', 'VERIFYING', 'REFINING'].includes(
        run.status,
      ),
    ).length;

  return {
    id: `${Date.now()}`,
    type: 'snapshot',
    at: new Date().toISOString(),
    pendingApprovals,
    activeRuns,
  };
}

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

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const scope = resolveScopeFromRequest(request, userId);
      const initial = buildSnapshot(scope);
      controller.enqueue(encodeEvent({ id: initial.id, event: initial.type, data: initial }));
      interval = setInterval(() => {
        const snapshot = buildSnapshot(scope);
        controller.enqueue(encodeEvent({ id: snapshot.id, event: snapshot.type, data: snapshot }));
      }, 5_000);
    },
    cancel() {
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
