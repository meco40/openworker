import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { getProjectsPath, getMissionControlUrl } from '@/lib/config';
import {
  ensureTaskDeliverablesFromProjectDir,
  triggerAutomatedTaskTest,
} from '@/server/tasks/autoTesting';
import type { Task, Agent, OpenClawSession } from '@/lib/types';

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface DispatchChatSendResult {
  userMsgId?: string;
  agentMsgId?: string;
  conversationId?: string;
  agentContent?: string;
  agentMetadata?: Record<string, unknown>;
}

interface DispatchFailure {
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

const MAX_DISPATCH_ATTEMPTS = 3;

function extractTaskCompleteSummary(text: string | undefined): string | null {
  const raw = String(text || '');
  const match = raw.match(/TASK_COMPLETE:\s*(.+)/i);
  if (!match) return null;
  const summary = match[1].trim();
  return summary.length > 0 ? summary : null;
}

function classifyDispatchFailure(
  result: DispatchChatSendResult | null | undefined,
): DispatchFailure | null {
  const metadata = result?.agentMetadata ?? {};
  const executionStatus = String(metadata.status || '')
    .trim()
    .toLowerCase();
  const content = String(result?.agentContent || '').trim();
  const contentLower = content.toLowerCase();

  if (executionStatus === 'tool_execution_required_unmet') {
    return {
      message:
        'Agent dispatch failed: no real execution was performed. Please retry dispatch after adjusting task instructions.',
      retryable: false,
      details: metadata,
    };
  }

  if (contentLower.startsWith('ai dispatch failed:')) {
    return {
      message: `Agent dispatch failed: ${content}`,
      retryable:
        contentLower.includes('aborted') ||
        contentLower.includes('all models failed') ||
        contentLower.includes('timeout') ||
        contentLower.includes('temporarily'),
      details: metadata,
    };
  }

  if (contentLower.startsWith('execution failed:')) {
    return {
      message: content || 'Agent execution failed.',
      retryable: false,
      details: metadata,
    };
  }

  if (metadata.ok === false) {
    const statusText = executionStatus || 'unknown_error';
    return {
      message: `Agent dispatch failed (${statusText}).`,
      retryable:
        statusText.includes('aborted') ||
        statusText.includes('timeout') ||
        statusText.includes('temporary') ||
        statusText.includes('rate_limit'),
      details: metadata,
    };
  }

  return null;
}

/**
 * POST /api/tasks/[id]/dispatch
 *
 * Dispatches a task to its assigned agent's runtime session.
 * Creates session if needed, sends task details to agent.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    // Get task with agent info
    const task = queryOne<Task & { assigned_agent_name?: string; workspace_id: string }>(
      `SELECT t.*, a.name as assigned_agent_name, a.is_master
       FROM tasks t
       LEFT JOIN agents a ON t.assigned_agent_id = a.id
       WHERE t.id = ?`,
      [id],
    );

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (!task.assigned_agent_id) {
      return NextResponse.json({ error: 'Task has no assigned agent' }, { status: 400 });
    }

    // Get agent details
    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [task.assigned_agent_id]);

    if (!agent) {
      return NextResponse.json({ error: 'Assigned agent not found' }, { status: 404 });
    }

    // Check if dispatching to the master agent while there are other orchestrators available
    if (agent.is_master) {
      // Check for other master agents in the same workspace (excluding this one)
      const otherOrchestrators = queryAll<{
        id: string;
        name: string;
        role: string;
      }>(
        `SELECT id, name, role
         FROM agents
         WHERE is_master = 1
         AND id != ?
         AND workspace_id = ?
         AND status != 'offline'`,
        [agent.id, task.workspace_id],
      );

      if (otherOrchestrators.length > 0) {
        return NextResponse.json(
          {
            success: false,
            warning: 'Other orchestrators available',
            message: `There ${otherOrchestrators.length === 1 ? 'is' : 'are'} ${otherOrchestrators.length} other orchestrator${otherOrchestrators.length === 1 ? '' : 's'} available in this workspace: ${otherOrchestrators.map((o) => o.name).join(', ')}. Consider assigning this task to them instead.`,
            otherOrchestrators,
          },
          { status: 409 },
        ); // 409 Conflict - indicating there's an alternative
      }
    }

    // Hard stop: execution dispatch cannot succeed when no skills/tools are installed.
    // This avoids opaque `tool_execution_required_unmet` failures later in the pipeline.
    const { getSkillRepository } = await import('@/server/skills/skillRepository');
    const skillRepo = await getSkillRepository();
    const installedSkillCount = skillRepo.listSkills().filter((skill) => skill.installed).length;
    if (installedSkillCount < 1) {
      return NextResponse.json(
        {
          error:
            'Cannot dispatch task: no execution tools are installed. Enable at least one skill (e.g. Safe Shell) and retry.',
          code: 'no_installed_tools',
        },
        { status: 409 },
      );
    }

    // Connect to runtime
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch (err) {
        console.error('Failed to connect to Mission Control runtime:', err);
        return NextResponse.json(
          { error: 'Failed to connect to Mission Control runtime' },
          { status: 503 },
        );
      }
    }

    // Get or create runtime session for this agent
    let session = queryOne<OpenClawSession>(
      'SELECT * FROM openclaw_sessions WHERE agent_id = ? AND status = ?',
      [agent.id, 'active'],
    );

    const now = new Date().toISOString();

    if (!session) {
      // Create session record
      const sessionId = uuidv4();
      const openclawSessionId = `mission-control-${agent.name.toLowerCase().replace(/\s+/g, '-')}`;

      run(
        `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, agent.id, openclawSessionId, 'mission-control', 'active', now, now],
      );

      session = queryOne<OpenClawSession>('SELECT * FROM openclaw_sessions WHERE id = ?', [
        sessionId,
      ]);

      // Log session creation
      run(
        `INSERT INTO events (id, type, agent_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'agent_status_changed', agent.id, `${agent.name} session created`, now],
      );
    }

    if (!session) {
      return NextResponse.json({ error: 'Failed to create agent session' }, { status: 500 });
    }

    // Build task message for agent
    const priorityEmoji =
      {
        low: '🔵',
        normal: '⚪',
        high: '🟡',
        urgent: '🔴',
      }[task.priority] || '⚪';

    // Get project path for deliverables
    const projectsPath = getProjectsPath();
    const projectDir = task.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const taskProjectDir = `${projectsPath}/${projectDir}`;
    const missionControlUrl = getMissionControlUrl();

    const taskMessage = `${priorityEmoji} **NEW TASK ASSIGNED**

**Title:** ${task.title}
${task.description ? `**Description:** ${task.description}\n` : ''}
**Priority:** ${task.priority.toUpperCase()}
${task.due_date ? `**Due:** ${task.due_date}\n` : ''}
**Task ID:** ${task.id}

**OUTPUT DIRECTORY:** ${taskProjectDir}
Create this directory and save all deliverables there.

**IMPORTANT:** After completing work, you MUST call these APIs:
1. Log activity: POST ${missionControlUrl}/api/tasks/${task.id}/activities
   Body: {"activity_type": "completed", "message": "Description of what was done"}
2. Register deliverable: POST ${missionControlUrl}/api/tasks/${task.id}/deliverables
   Body: {"deliverable_type": "file", "title": "File name", "path": "${taskProjectDir}/filename.html"}
3. Update status: PATCH ${missionControlUrl}/api/tasks/${task.id}
   Body: {"status": "review"}

When complete, reply with:
\`TASK_COMPLETE: [brief summary of what you did]\`

If you need help or clarification, ask the orchestrator.`;

    // Send message to agent's session using chat.send
    try {
      // Use sessionKey for routing to the agent's session
      // Format: agent:main:{openclaw_session_id}
      const sessionKey = `agent:main:${session.openclaw_session_id}`;
      let sendResult: DispatchChatSendResult | null = null;

      for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt += 1) {
        sendResult = await client.call<DispatchChatSendResult>('chat.send', {
          sessionKey,
          message: taskMessage,
          idempotencyKey: `dispatch-${task.id}-${Date.now()}-${attempt}`,
        });

        const failure = classifyDispatchFailure(sendResult);
        if (!failure) {
          break;
        }

        const isLastAttempt = attempt >= MAX_DISPATCH_ATTEMPTS;
        if (!failure.retryable || isLastAttempt) {
          console.error(
            `Dispatch failed for task ${task.id} on attempt ${attempt}/${MAX_DISPATCH_ATTEMPTS}`,
            {
              message: failure.message,
              details: failure.details,
              agentContent: sendResult?.agentContent,
            },
          );
          return NextResponse.json(
            {
              error: failure.message,
              details: failure.details ?? sendResult?.agentMetadata ?? null,
            },
            { status: 502 },
          );
        }

        console.warn(
          `Dispatch retry ${attempt}/${MAX_DISPATCH_ATTEMPTS} for task ${task.id}: ${failure.message}`,
        );
      }

      const completionSummary = extractTaskCompleteSummary(sendResult?.agentContent);

      if (completionSummary) {
        const shouldAutoTest = task.status !== 'review' && task.status !== 'done';
        if (task.status !== 'testing' && task.status !== 'review' && task.status !== 'done') {
          run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', ['testing', now, id]);
        }

        if (shouldAutoTest) {
          ensureTaskDeliverablesFromProjectDir({
            taskId: task.id,
            taskTitle: task.title,
            projectDir: taskProjectDir,
          });
          triggerAutomatedTaskTest(task.id);
        }

        const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
        if (updatedTask) {
          broadcast({
            type: 'task_updated',
            payload: updatedTask,
          });
        }

        run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', [
          'standby',
          now,
          agent.id,
        ]);

        run(
          `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(),
            'task_dispatched',
            agent.id,
            task.id,
            `Task "${task.title}" dispatched to ${agent.name}`,
            now,
          ],
        );

        run(
          `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(),
            'task_completed',
            agent.id,
            task.id,
            `${agent.name} completed: ${completionSummary}`,
            now,
          ],
        );

        run(
          `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            task.id,
            agent.id,
            'completed',
            `Agent reported completion: ${completionSummary}`,
            now,
          ],
        );

        return NextResponse.json({
          success: true,
          task_id: task.id,
          agent_id: agent.id,
          session_id: session.openclaw_session_id,
          completed: true,
          new_status: 'testing',
          summary: completionSummary,
          message: 'Task dispatched and completed by agent',
        });
      }

      // Update task status to in_progress
      run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', ['in_progress', now, id]);

      // Broadcast task update
      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
      if (updatedTask) {
        broadcast({
          type: 'task_updated',
          payload: updatedTask,
        });
      }

      // Update agent status to working
      run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', ['working', now, agent.id]);

      // Log dispatch event to events table
      const eventId = uuidv4();
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          eventId,
          'task_dispatched',
          agent.id,
          task.id,
          `Task "${task.title}" dispatched to ${agent.name}`,
          now,
        ],
      );

      // Log dispatch activity to task_activities table (for Activity tab)
      const activityId = crypto.randomUUID();
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          activityId,
          task.id,
          agent.id,
          'status_changed',
          `Task dispatched to ${agent.name} - Agent is now working on this task`,
          now,
        ],
      );

      return NextResponse.json({
        success: true,
        task_id: task.id,
        agent_id: agent.id,
        session_id: session.openclaw_session_id,
        message: 'Task dispatched to agent',
      });
    } catch (err) {
      console.error('Failed to send message to agent:', err);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  } catch (error) {
    console.error('Failed to dispatch task:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
