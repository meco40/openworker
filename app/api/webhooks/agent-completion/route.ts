import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { queryOne, run } from '@/lib/db';
import { allowInsecureWebhookFallback } from '@/server/channels/webhookAuth';
import {
  ensureTaskDeliverablesFromProjectDir,
  triggerAutomatedTaskTest,
} from '@/server/tasks/autoTesting';
import type { Task, OpenClawSession } from '@/lib/types';

/**
 * Verify HMAC-SHA256 signature of webhook request
 */
function verifyWebhookSignature(signature: string, rawBody: string): boolean {
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (!webhookSecret) {
    return allowInsecureWebhookFallback();
  }

  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }

  const expectedSignature = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const received = Buffer.from(signature, 'hex');
  const expected = Buffer.from(expectedSignature, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/**
 * POST /api/webhooks/agent-completion
 *
 * Receives completion notifications from agents.
 * Expected payload:
 * {
 *   "session_id": "mission-control-engineering",
 *   "message": "TASK_COMPLETE: Built the authentication system"
 * }
 *
 * Or can be called with task_id directly:
 * {
 *   "task_id": "uuid",
 *   "summary": "Completed the task successfully"
 * }
 */
export async function POST(request: NextRequest) {
  try {
    // Read raw body for signature verification
    const rawBody = await request.text();

    const signature = request.headers.get('x-webhook-signature') || '';
    if (!verifyWebhookSignature(signature, rawBody)) {
      console.warn('[WEBHOOK] Invalid signature attempt');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = JSON.parse(rawBody);
    const now = new Date().toISOString();

    // Handle direct task_id completion
    if (body.task_id) {
      const task = queryOne<Task & { assigned_agent_name?: string }>(
        `SELECT t.*, a.name as assigned_agent_name
         FROM tasks t
         LEFT JOIN agents a ON t.assigned_agent_id = a.id
         WHERE t.id = ?`,
        [body.task_id],
      );

      if (!task) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }

      // Only move to testing if not already in testing, review, or done
      // (Don't overwrite user's approval or testing results)
      const shouldAutoTest = !['testing', 'review', 'done'].includes(task.status);
      if (task.status !== 'testing' && task.status !== 'review' && task.status !== 'done') {
        run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', ['testing', now, task.id]);
      }
      if (shouldAutoTest) {
        ensureTaskDeliverablesFromProjectDir({
          taskId: task.id,
          taskTitle: task.title,
        });
        triggerAutomatedTaskTest(task.id);
      }

      // Log completion
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          'task_completed',
          task.assigned_agent_id,
          task.id,
          `${task.assigned_agent_name} completed: ${body.summary || 'Task finished'}`,
          now,
        ],
      );

      // Set agent back to standby
      if (task.assigned_agent_id) {
        run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', [
          'standby',
          now,
          task.assigned_agent_id,
        ]);
      }

      return NextResponse.json({
        success: true,
        task_id: task.id,
        new_status: 'testing',
        message: 'Task moved to testing for automated verification',
      });
    }

    // Handle session-based completion (from message parsing)
    if (body.session_id && body.message) {
      // Parse TASK_COMPLETE message
      const completionMatch = body.message.match(/TASK_COMPLETE:\s*(.+)/i);
      if (!completionMatch) {
        return NextResponse.json(
          { error: 'Invalid completion message format. Expected: TASK_COMPLETE: [summary]' },
          { status: 400 },
        );
      }

      const summary = completionMatch[1].trim();

      // Find agent by session
      const session = queryOne<OpenClawSession>(
        'SELECT * FROM openclaw_sessions WHERE openclaw_session_id = ? AND status = ?',
        [body.session_id, 'active'],
      );

      if (!session) {
        return NextResponse.json({ error: 'Session not found or inactive' }, { status: 404 });
      }

      // Find active task for this agent
      const task = queryOne<Task & { assigned_agent_name?: string }>(
        `SELECT t.*, a.name as assigned_agent_name
         FROM tasks t
         LEFT JOIN agents a ON t.assigned_agent_id = a.id
         WHERE t.assigned_agent_id = ? 
           AND t.status IN ('assigned', 'in_progress')
         ORDER BY t.updated_at DESC
         LIMIT 1`,
        [session.agent_id],
      );

      if (!task) {
        return NextResponse.json({ error: 'No active task found for this agent' }, { status: 404 });
      }

      // Only move to testing if not already in testing, review, or done
      // (Don't overwrite user's approval or testing results)
      const shouldAutoTest = !['testing', 'review', 'done'].includes(task.status);
      if (task.status !== 'testing' && task.status !== 'review' && task.status !== 'done') {
        run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', ['testing', now, task.id]);
      }
      if (shouldAutoTest) {
        ensureTaskDeliverablesFromProjectDir({
          taskId: task.id,
          taskTitle: task.title,
        });
        triggerAutomatedTaskTest(task.id);
      }

      // Log completion with summary
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          'task_completed',
          session.agent_id,
          task.id,
          `${task.assigned_agent_name} completed: ${summary}`,
          now,
        ],
      );

      // Set agent back to standby
      run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', [
        'standby',
        now,
        session.agent_id,
      ]);

      return NextResponse.json({
        success: true,
        task_id: task.id,
        agent_id: session.agent_id,
        summary,
        new_status: 'testing',
        message: 'Task moved to testing for automated verification',
      });
    }

    return NextResponse.json(
      { error: 'Invalid payload. Provide either task_id or session_id + message' },
      { status: 400 },
    );
  } catch (error) {
    console.error('Agent completion webhook error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * GET /api/webhooks/agent-completion
 *
 * Returns webhook status without exposing task or agent data.
 */
export async function GET() {
  return NextResponse.json({
    status: 'active',
    endpoint: '/api/webhooks/agent-completion',
  });
}
