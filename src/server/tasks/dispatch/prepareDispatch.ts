import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { getMissionControlUrl, getProjectsPath } from '@/lib/config';
import { getOpenClawClient } from '@/lib/openclaw/client';
import type { Agent, OpenClawSession } from '@/lib/types';
import { buildDispatchTaskMessage } from './message';
import type { DispatchPreparationResult, DispatchTaskRow } from './types';

interface OrchestratorSummary {
  id: string;
  name: string;
  role: string;
}

function buildProjectDirectory(taskTitle: string): string {
  return String(taskTitle || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildOtherOrchestratorsMessage(otherOrchestrators: OrchestratorSummary[]): string {
  const count = otherOrchestrators.length;
  const plural = count === 1 ? '' : 's';
  const verb = count === 1 ? 'is' : 'are';
  const names = otherOrchestrators.map((orchestrator) => orchestrator.name).join(', ');
  return `There ${verb} ${count} other orchestrator${plural} available in this workspace: ${names}. Consider assigning this task to them instead.`;
}

export async function prepareDispatch(taskId: string): Promise<DispatchPreparationResult> {
  const task = queryOne<DispatchTaskRow>(
    `SELECT t.*, a.name as assigned_agent_name, a.is_master
     FROM tasks t
     LEFT JOIN agents a ON t.assigned_agent_id = a.id
     WHERE t.id = ?`,
    [taskId],
  );

  if (!task) {
    return {
      kind: 'response',
      response: { status: 404, body: { error: 'Task not found' } },
    };
  }

  if (!task.assigned_agent_id) {
    return {
      kind: 'response',
      response: { status: 400, body: { error: 'Task has no assigned agent' } },
    };
  }

  const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [task.assigned_agent_id]);
  if (!agent) {
    return {
      kind: 'response',
      response: { status: 404, body: { error: 'Assigned agent not found' } },
    };
  }

  if (agent.is_master) {
    const otherOrchestrators = queryAll<OrchestratorSummary>(
      `SELECT id, name, role
       FROM agents
       WHERE is_master = 1
       AND id != ?
       AND workspace_id = ?
       AND status != 'offline'`,
      [agent.id, task.workspace_id],
    );

    if (otherOrchestrators.length > 0) {
      return {
        kind: 'response',
        response: {
          status: 409,
          body: {
            success: false,
            warning: 'Other orchestrators available',
            message: buildOtherOrchestratorsMessage(otherOrchestrators),
            otherOrchestrators,
          },
        },
      };
    }
  }

  const { getSkillRepository } = await import('@/server/skills/skillRepository');
  const skillRepo = await getSkillRepository();
  const installedSkillCount = skillRepo.listSkills().filter((skill) => skill.installed).length;
  if (installedSkillCount < 1) {
    return {
      kind: 'response',
      response: {
        status: 409,
        body: {
          error:
            'Cannot dispatch task: no execution tools are installed. Enable at least one skill (e.g. Safe Shell) and retry.',
          code: 'no_installed_tools',
        },
      },
    };
  }

  const client = getOpenClawClient();
  if (!client.isConnected()) {
    try {
      await client.connect();
    } catch (error) {
      console.error('Failed to connect to Mission Control runtime:', error);
      return {
        kind: 'response',
        response: {
          status: 503,
          body: { error: 'Failed to connect to Mission Control runtime' },
        },
      };
    }
  }

  const now = new Date().toISOString();
  let session = queryOne<OpenClawSession>(
    'SELECT * FROM openclaw_sessions WHERE agent_id = ? AND status = ?',
    [agent.id, 'active'],
  );

  if (!session) {
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

    run(
      `INSERT INTO events (id, type, agent_id, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), 'agent_status_changed', agent.id, `${agent.name} session created`, now],
    );
  }

  if (!session) {
    return {
      kind: 'response',
      response: { status: 500, body: { error: 'Failed to create agent session' } },
    };
  }

  const projectsPath = getProjectsPath();
  const projectDir = buildProjectDirectory(task.title);
  const taskProjectDir = `${projectsPath}/${projectDir}`;
  const missionControlUrl = getMissionControlUrl();
  const taskMessage = buildDispatchTaskMessage({
    task,
    missionControlUrl,
    taskProjectDir,
  });

  return {
    kind: 'context',
    context: {
      taskId,
      task,
      agent,
      session,
      now,
      taskMessage,
      taskProjectDir,
      client,
    },
  };
}
