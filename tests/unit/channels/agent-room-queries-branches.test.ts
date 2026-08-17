import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRoomQueries } from '@/server/channels/messages/repository/queries/agentRoom';

const openDbs: Database.Database[] = [];

function createQueries() {
  const db = new Database(':memory:');
  openDbs.push(db);
  db.exec(`
    CREATE TABLE agent_room_swarms (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT,
      title TEXT NOT NULL,
      task TEXT NOT NULL,
      lead_persona_id TEXT NOT NULL,
      units_json TEXT NOT NULL,
      status TEXT NOT NULL,
      current_phase TEXT NOT NULL,
      consensus_score REAL NOT NULL,
      hold_flag INTEGER NOT NULL,
      artifact_json TEXT NOT NULL,
      artifact_history_json TEXT NOT NULL,
      friction_json TEXT NOT NULL,
      last_seq INTEGER NOT NULL,
      current_deploy_command_id TEXT,
      search_enabled INTEGER NOT NULL,
      swarm_template TEXT,
      pause_between_phases INTEGER NOT NULL,
      phase_buffer_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return {
    db,
    queries: new AgentRoomQueries(db, (userId = '') => userId.trim().toLowerCase()),
  };
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    if (db.open) db.close();
  }
});

describe('AgentRoomQueries branches', () => {
  it('creates, lists, gets, and checks conversations with normalized user ids', () => {
    const { queries } = createQueries();
    const created = queries.createAgentRoomSwarm({
      conversationId: 'conv-1',
      userId: ' User-1 ',
      title: 'Swarm',
      task: 'Investigate',
      leadPersonaId: 'persona-1',
      units: [{ personaId: 'persona-1', role: 'lead' }],
      status: 'mystery' as never,
      currentPhase: 'weird' as never,
      consensusScore: Number.NaN,
      holdFlag: true,
      artifact: '{"ok":true}',
      artifactHistory: ['v1'],
      friction: {
        level: 'medium',
        confidence: 0.7,
        hold: false,
        reasons: ['branch'],
        updatedAt: '2026-04-22T10:00:00.000Z',
      },
      lastSeq: Number.NaN,
      searchEnabled: true,
      swarmTemplate: 'template-1',
      pauseBetweenPhases: true,
    });

    expect(created.userId).toBe('user-1');
    expect(created.status).toBe('idle');
    expect(created.currentPhase).toBe('analysis');
    expect(queries.listAgentRoomSwarms(' user-1 ', 999)).toHaveLength(1);
    expect(queries.getAgentRoomSwarm(created.id, 'USER-1')?.id).toBe(created.id);
    expect(queries.getAgentRoomSwarm('missing', 'user-1')).toBeNull();
    expect(queries.isAgentRoomConversation('conv-1', 'USER-1')).toBe(true);
    expect(queries.isAgentRoomConversation('conv-1')).toBe(true);
    expect(queries.isAgentRoomConversation('   ')).toBe(false);
  });

  it('updates stored swarm state including legacy phase-buffer migration and recovery helpers', () => {
    const { db, queries } = createQueries();
    const created = queries.createAgentRoomSwarm({
      conversationId: 'conv-2',
      userId: 'user-2',
      title: 'Swarm',
      task: 'Task',
      leadPersonaId: 'persona-2',
      units: [],
      status: 'running',
    });

    db.prepare(
      'UPDATE agent_room_swarms SET phase_buffer_json = ?, status = ?, hold_flag = 0 WHERE id = ?',
    ).run(
      JSON.stringify(['agentsession:persona-x:session-x:7', 'speaker:persona-y', 'invalid']),
      'unknown',
      created.id,
    );

    const patched = queries.updateAgentRoomSwarm(created.id, 'user-2', {
      sessionId: 'sess-2',
      title: 'Updated',
      task: 'Updated task',
      leadPersonaId: 'persona-3',
      units: [{ personaId: 'persona-3', role: 'critic' }],
      status: 'completed',
      currentPhase: 'result',
      consensusScore: 4.2,
      holdFlag: false,
      artifact: 'artifact',
      artifactHistory: ['v1', 'v2'],
      friction: {
        level: 'high',
        confidence: 1,
        hold: true,
        reasons: ['done'],
        updatedAt: '2026-04-22T11:00:00.000Z',
      },
      lastSeq: 22,
      currentDeployCommandId: 'deploy-1',
      searchEnabled: false,
      swarmTemplate: null,
      pauseBetweenPhases: false,
      phaseBuffer: [{ type: 'speaker', personaId: 'persona-z' }],
    });

    expect(patched).toMatchObject({
      title: 'Updated',
      status: 'completed',
      currentPhase: 'result',
      currentDeployCommandId: 'deploy-1',
    });
    expect(patched?.phaseBuffer).toEqual([{ type: 'speaker', personaId: 'persona-z' }]);
    expect(queries.updateAgentRoomSwarm('missing', 'user-2', { title: 'nope' })).toBeNull();

    queries.createAgentRoomSwarm({
      conversationId: 'conv-3',
      userId: 'user-2',
      title: 'Recover me',
      task: 'Task',
      leadPersonaId: 'persona-2',
      units: [],
      status: 'running',
    });
    expect(queries.recoverRunningSwarms()).toBe(1);
    expect(queries.listRunningSwarms(500)).toHaveLength(0);
  });

  it('deletes swarms and computes metrics with fallback values', () => {
    const { queries } = createQueries();
    const running = queries.createAgentRoomSwarm({
      conversationId: 'conv-4',
      userId: 'user-3',
      title: 'Running',
      task: 'Task',
      leadPersonaId: 'persona-4',
      units: [],
      status: 'running',
      holdFlag: true,
    });
    const errored = queries.createAgentRoomSwarm({
      conversationId: 'conv-5',
      userId: 'user-3',
      title: 'Errored',
      task: 'Task',
      leadPersonaId: 'persona-4',
      units: [],
      status: 'error',
    });

    const metrics = queries.getAgentRoomSwarmMetrics('user-3');
    expect(metrics.runningSwarms).toBe(1);
    expect(metrics.holdSwarms).toBe(1);
    expect(metrics.lastErrorAt).toBe(errored.updatedAt);

    expect(queries.deleteAgentRoomSwarm(running.id, 'user-3')).toBe(true);
    expect(queries.deleteAgentRoomSwarm(running.id, 'user-3')).toBe(false);
  });
});
