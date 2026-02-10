import { getSSEManager } from '../../../../src/server/channels/sse/manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const manager = getSSEManager();

  const stream = new ReadableStream({
    start(controller) {
      const clientId = manager.addClient(controller);

      // Send initial heartbeat
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(`event: connected\ndata: ${JSON.stringify({ clientId })}\n\n`),
      );

      // Cleanup on abort — we rely on the client disconnecting
      // The SSEManager handles stale clients via try/catch in broadcast
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          clearInterval(keepalive);
          manager.removeClient(clientId);
        }
      }, 30000);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
