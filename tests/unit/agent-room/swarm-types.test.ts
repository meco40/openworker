import { describe, expect, it } from 'vitest';
import { SWARM_LAYOUT_MODES, SWARM_OUTPUT_TABS } from '@/modules/agent-room/swarmViewState';
import { parseSwarmRecord } from '@/modules/agent-room/swarmTypes';

describe('swarm types', () => {
  it('defines expected layout modes and tabs', () => {
    expect(SWARM_LAYOUT_MODES).toEqual(['split', 'chat', 'board']);
    expect(SWARM_OUTPUT_TABS).toEqual([
      'solution_artifact',
      'logic_graph',
      'history',
      'conflict_radar',
    ]);
  });

  it('parses server payload with persona-first unit contract and session id', () => {
    const parsed = parseSwarmRecord({
      id: 'swarm-1',
      conversation_id: 'conv-1',
      user_id: 'user-1',
      session_id: 'session-1',
      title: 'Research',
      task: 'Analyze options',
      lead_persona_id: 'persona-lead',
      units_json: [
        { personaId: 'persona-lead', role: 'lead' },
        { personaId: 'persona-specialist', role: 'specialist' },
      ],
      status: 'idle',
      current_phase: 'analysis',
      consensus_score: 0,
      hold_flag: 0,
      artifact_json: '',
      artifact_history_json: [],
      friction_json: { level: 'low', confidence: 0, hold: false, reasons: [], updatedAt: 'now' },
      last_seq: 0,
      created_at: '2026-02-24T00:00:00.000Z',
      updated_at: '2026-02-24T00:00:00.000Z',
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.leadPersonaId).toBe('persona-lead');
    expect(parsed?.units[1].personaId).toBe('persona-specialist');
    expect(parsed?.sessionId).toBe('session-1');
  });
});

