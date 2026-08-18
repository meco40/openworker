/**
 * Server-Sent Events (SSE) endpoint for real-time updates
 * Clients connect to this endpoint and receive live event broadcasts
 */

import { getSseDiagnostics, registerClient, unregisterClient } from '@/lib/events';
import type { SSEEvent } from '@/lib/types';
import { withUserContext } from '../../_shared/withUserContext';
import {
  getAccessibleWorkspaceIds,
  getAgentWorkspaceId,
  getTaskWorkspaceId,
} from '@/server/auth/workspaceAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withUserContext(async ({ request, userContext }) => {
  const encoder = new TextEncoder();
  const workspaceIds = new Set(getAccessibleWorkspaceIds(userContext));

  const isVisible = (event: SSEEvent): boolean => {
    const payload = event.payload as Record<string, unknown>;
    const workspaceId = typeof payload.workspace_id === 'string' ? payload.workspace_id : null;
    if (workspaceId) return workspaceIds.has(workspaceId);

    const taskId =
      typeof payload.taskId === 'string'
        ? payload.taskId
        : typeof payload.task_id === 'string'
          ? payload.task_id
          : null;
    if (taskId) {
      const taskWorkspaceId = getTaskWorkspaceId(taskId);
      return Boolean(taskWorkspaceId && workspaceIds.has(taskWorkspaceId));
    }

    const agentId =
      typeof payload.agentId === 'string'
        ? payload.agentId
        : typeof payload.agent_id === 'string'
          ? payload.agent_id
          : null;
    if (agentId) {
      const agentWorkspaceId = getAgentWorkspaceId(agentId);
      return Boolean(agentWorkspaceId && workspaceIds.has(agentWorkspaceId));
    }

    // Only explicitly global events may pass without a resource relation.
    return false;
  };

  // Create a readable stream for SSE
  const stream = new ReadableStream({
    start(controller) {
      if (request.signal.aborted) {
        controller.close();
        return;
      }

      // Register this client
      registerClient(controller, isVisible);

      // Send initial connection message
      const connectMsg = encoder.encode(`: connected\n\n`);
      controller.enqueue(connectMsg);

      const diagnostics = getSseDiagnostics();
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: 'sse_connected', payload: diagnostics })}\n\n`,
        ),
      );

      // Set up keep-alive ping every 30 seconds
      const keepAliveInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch (_error) {
          // Client disconnected
          clearInterval(keepAliveInterval);
        }
      }, 30000);

      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        clearInterval(keepAliveInterval);
        unregisterClient(controller);
        try {
          controller.close();
        } catch (_error) {
          // Controller may already be closed
        }
      });
    },
  });

  // Return SSE response
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
      'X-SSE-Mode': 'single-node-in-memory',
    },
  });
});
