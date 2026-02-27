import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  AgentRoomSwarmFriction,
  AgentRoomSwarmMetrics,
  AgentRoomSwarmPhase,
  AgentRoomSwarmRecord,
  AgentRoomSwarmStatus,
  AgentRoomSwarmUnit,
} from '@/server/channels/messages/repository/types';
import type { PhaseBufferEntry } from '@/server/agent-room/types';

const DEFAULT_FRICTION: AgentRoomSwarmFriction = {
  level: 'low',
  confidence: 0,
  hold: false,
  reasons: [],
  updatedAt: new Date(0).toISOString(),
};

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Parse phaseBuffer from SQLite, handling both legacy string format
 * (e.g. "agentsession:pid:sid:seq") and new typed object format.
 */
function parsePhaseBuffer(value: unknown): PhaseBufferEntry[] {
  const raw = safeJsonParse<unknown[]>(value, []);
  if (!Array.isArray(raw)) return [];
  const entries: PhaseBufferEntry[] = [];
  for (const item of raw) {
    if (typeof item === 'object' && item !== null && 'type' in item) {
      // New typed format
      entries.push(item as PhaseBufferEntry);
    } else if (typeof item === 'string') {
      // Legacy colon-delimited string format — migrate on read
      if (item.startsWith('agentsession:')) {
        const parts = item.slice('agentsession:'.length).split(':');
        if (parts.length >= 3) {
          entries.push({
            type: 'agentsession',
            personaId: parts[0],
            sessionId: parts[1],
            lastSeq: Number(parts[2]) || 0,
          });
        }
      } else if (item.startsWith('speaker:')) {
        const personaId = item.slice('speaker:'.length).trim();
        if (personaId) {
          entries.push({ type: 'speaker', personaId });
        }
      }
    }
  }
  return entries;
}

function normalizePhase(value: string): AgentRoomSwarmPhase {
  if (
    value === 'analysis' ||
    value === 'research' ||
    value === 'ideation' ||
    value === 'critique' ||
    value === 'best_case' ||
    value === 'result'
  ) {
    return value;
  }
  return 'analysis';
}

function normalizeStatus(value: string): AgentRoomSwarmStatus {
  if (
    value === 'idle' ||
    value === 'running' ||
    value === 'hold' ||
    value === 'completed' ||
    value === 'aborted' ||
    value === 'error'
  ) {
    return value;
  }
  return 'idle';
}

function toRecord(row: Record<string, unknown>): AgentRoomSwarmRecord {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    userId: String(row.user_id),
    sessionId: row.session_id ? String(row.session_id) : null,
    title: String(row.title),
    task: String(row.task),
    leadPersonaId: String(row.lead_persona_id),
    units: safeJsonParse<AgentRoomSwarmUnit[]>(row.units_json, []),
    status: normalizeStatus(String(row.status || 'idle')),
    currentPhase: normalizePhase(String(row.current_phase || 'analysis')),
    consensusScore: Number(row.consensus_score || 0),
    holdFlag: Number(row.hold_flag || 0) === 1,
    artifact: String(row.artifact_json || ''),
    artifactHistory: safeJsonParse<string[]>(row.artifact_history_json, []),
    friction: safeJsonParse<AgentRoomSwarmFriction>(row.friction_json, DEFAULT_FRICTION),
    lastSeq: Number(row.last_seq || 0),
    currentDeployCommandId: row.current_deploy_command_id
      ? String(row.current_deploy_command_id)
      : null,
    searchEnabled: Number(row.search_enabled || 0) === 1,
    swarmTemplate: row.swarm_template ? String(row.swarm_template) : null,
    pauseBetweenPhases: Number(row.pause_between_phases || 0) === 1,
    phaseBuffer: parsePhaseBuffer(row.phase_buffer_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class AgentRoomQueries {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly normalizeUserId: (userId?: string) => string,
  ) {}

  createAgentRoomSwarm(input: {
    conversationId: string;
    userId: string;
    title: string;
    task: string;
    leadPersonaId: string;
    units: AgentRoomSwarmUnit[];
    sessionId?: string | null;
    status?: AgentRoomSwarmStatus;
    currentPhase?: AgentRoomSwarmPhase;
    consensusScore?: number;
    holdFlag?: boolean;
    artifact?: string;
    artifactHistory?: string[];
    friction?: AgentRoomSwarmFriction;
    lastSeq?: number;
    searchEnabled?: boolean;
    swarmTemplate?: string | null;
    pauseBetweenPhases?: boolean;
  }): AgentRoomSwarmRecord {
    const id = `swarm-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const normalizedUserId = this.normalizeUserId(input.userId);
    const status = input.status || 'idle';
    const currentPhase = input.currentPhase || 'analysis';
    const consensusScore = Number.isFinite(Number(input.consensusScore))
      ? Number(input.consensusScore)
      : 0;
    const holdFlag = input.holdFlag ? 1 : 0;
    const friction = input.friction || {
      ...DEFAULT_FRICTION,
      updatedAt: now,
    };

    this.db
      .prepare(
        `
        INSERT INTO agent_room_swarms (
          id, conversation_id, user_id, session_id, title, task, lead_persona_id, units_json,
          status, current_phase, consensus_score, hold_flag, artifact_json, artifact_history_json,
          friction_json, last_seq, search_enabled, swarm_template, pause_between_phases,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        input.conversationId,
        normalizedUserId,
        input.sessionId || null,
        input.title,
        input.task,
        input.leadPersonaId,
        JSON.stringify(input.units || []),
        status,
        currentPhase,
        consensusScore,
        holdFlag,
        String(input.artifact || ''),
        JSON.stringify(input.artifactHistory || []),
        JSON.stringify(friction),
        Number.isFinite(Number(input.lastSeq)) ? Number(input.lastSeq) : 0,
        input.searchEnabled ? 1 : 0,
        input.swarmTemplate || null,
        input.pauseBetweenPhases ? 1 : 0,
        now,
        now,
      );

    return this.getAgentRoomSwarm(id, normalizedUserId)!;
  }

  listAgentRoomSwarms(userId: string, limit = 50): AgentRoomSwarmRecord[] {
    const normalizedUserId = this.normalizeUserId(userId);
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit || 50)));
    const rows = this.db
      .prepare(
        `
        SELECT * FROM agent_room_swarms
        WHERE user_id = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `,
      )
      .all(normalizedUserId, safeLimit) as Array<Record<string, unknown>>;
    return rows.map(toRecord);
  }

  getAgentRoomSwarm(id: string, userId: string): AgentRoomSwarmRecord | null {
    const normalizedUserId = this.normalizeUserId(userId);
    const row = this.db
      .prepare(
        `
        SELECT * FROM agent_room_swarms
        WHERE id = ? AND user_id = ?
        LIMIT 1
      `,
      )
      .get(id, normalizedUserId) as Record<string, unknown> | undefined;
    return row ? toRecord(row) : null;
  }

  isAgentRoomConversation(conversationId: string, userId?: string): boolean {
    const normalizedConversationId = String(conversationId || '').trim();
    if (!normalizedConversationId) return false;

    if (userId) {
      const normalizedUserId = this.normalizeUserId(userId);
      const row = this.db
        .prepare(
          `
          SELECT 1
          FROM agent_room_swarms
          WHERE conversation_id = ? AND user_id = ?
          LIMIT 1
        `,
        )
        .get(normalizedConversationId, normalizedUserId) as { 1?: number } | undefined;
      return Boolean(row);
    }

    const row = this.db
      .prepare(
        `
        SELECT 1
        FROM agent_room_swarms
        WHERE conversation_id = ?
        LIMIT 1
      `,
      )
      .get(normalizedConversationId) as { 1?: number } | undefined;
    return Boolean(row);
  }

  updateAgentRoomSwarm(
    id: string,
    userId: string,
    patch: {
      sessionId?: string | null;
      title?: string;
      task?: string;
      leadPersonaId?: string;
      units?: AgentRoomSwarmUnit[];
      status?: AgentRoomSwarmStatus;
      currentPhase?: AgentRoomSwarmPhase;
      consensusScore?: number;
      holdFlag?: boolean;
      artifact?: string;
      artifactHistory?: string[];
      friction?: AgentRoomSwarmFriction;
      lastSeq?: number;
      currentDeployCommandId?: string | null;
      searchEnabled?: boolean;
      swarmTemplate?: string | null;
      pauseBetweenPhases?: boolean;
      phaseBuffer?: PhaseBufferEntry[];
    },
  ): AgentRoomSwarmRecord | null {
    const normalizedUserId = this.normalizeUserId(userId);
    const existing = this.getAgentRoomSwarm(id, normalizedUserId);
    if (!existing) return null;

    const updates: string[] = [];
    const values: unknown[] = [];
    if (patch.sessionId !== undefined) {
      updates.push('session_id = ?');
      values.push(patch.sessionId || null);
    }
    if (patch.title !== undefined) {
      updates.push('title = ?');
      values.push(patch.title);
    }
    if (patch.task !== undefined) {
      updates.push('task = ?');
      values.push(patch.task);
    }
    if (patch.leadPersonaId !== undefined) {
      updates.push('lead_persona_id = ?');
      values.push(patch.leadPersonaId);
    }
    if (patch.units !== undefined) {
      updates.push('units_json = ?');
      values.push(JSON.stringify(patch.units));
    }
    if (patch.status !== undefined) {
      updates.push('status = ?');
      values.push(patch.status);
    }
    if (patch.currentPhase !== undefined) {
      updates.push('current_phase = ?');
      values.push(patch.currentPhase);
    }
    if (patch.consensusScore !== undefined) {
      updates.push('consensus_score = ?');
      values.push(Number(patch.consensusScore));
    }
    if (patch.holdFlag !== undefined) {
      updates.push('hold_flag = ?');
      values.push(patch.holdFlag ? 1 : 0);
    }
    if (patch.artifact !== undefined) {
      updates.push('artifact_json = ?');
      values.push(patch.artifact);
    }
    if (patch.artifactHistory !== undefined) {
      updates.push('artifact_history_json = ?');
      values.push(JSON.stringify(patch.artifactHistory));
    }
    if (patch.friction !== undefined) {
      updates.push('friction_json = ?');
      values.push(JSON.stringify(patch.friction));
    }
    if (patch.lastSeq !== undefined) {
      updates.push('last_seq = ?');
      values.push(Number(patch.lastSeq));
    }
    if (patch.currentDeployCommandId !== undefined) {
      updates.push('current_deploy_command_id = ?');
      values.push(patch.currentDeployCommandId || null);
    }
    if (patch.searchEnabled !== undefined) {
      updates.push('search_enabled = ?');
      values.push(patch.searchEnabled ? 1 : 0);
    }
    if (patch.swarmTemplate !== undefined) {
      updates.push('swarm_template = ?');
      values.push(patch.swarmTemplate || null);
    }
    if (patch.pauseBetweenPhases !== undefined) {
      updates.push('pause_between_phases = ?');
      values.push(patch.pauseBetweenPhases ? 1 : 0);
    }
    if (patch.phaseBuffer !== undefined) {
      updates.push('phase_buffer_json = ?');
      values.push(JSON.stringify(patch.phaseBuffer));
    }

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id, normalizedUserId);

    this.db
      .prepare(
        `
        UPDATE agent_room_swarms
        SET ${updates.join(', ')}
        WHERE id = ? AND user_id = ?
      `,
      )
      .run(...values);

    return this.getAgentRoomSwarm(id, normalizedUserId);
  }

  /** Admin query (no userId guard) — used by server-side orchestrator only. */
  listRunningSwarms(limit = 50): AgentRoomSwarmRecord[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit || 50)));
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_room_swarms WHERE status = 'running' ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(safeLimit) as Array<Record<string, unknown>>;
    return rows.map(toRecord);
  }

  /**
   * Admin recovery — sets all running swarms to 'hold' on server restart.
   * Returns the number of swarms affected.
   */
  recoverRunningSwarms(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE agent_room_swarms SET status = 'hold', hold_flag = 1, updated_at = ? WHERE status = 'running'`,
      )
      .run(now);
    return Number(result.changes || 0);
  }

  deleteAgentRoomSwarm(id: string, userId: string): boolean {
    const normalizedUserId = this.normalizeUserId(userId);
    const result = this.db
      .prepare('DELETE FROM agent_room_swarms WHERE id = ? AND user_id = ?')
      .run(id, normalizedUserId);
    return Number(result.changes || 0) > 0;
  }

  getAgentRoomSwarmMetrics(userId: string): AgentRoomSwarmMetrics {
    const normalizedUserId = this.normalizeUserId(userId);
    const runningRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM agent_room_swarms WHERE user_id = ? AND status = 'running'`,
      )
      .get(normalizedUserId) as { count: number };
    const holdRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM agent_room_swarms WHERE user_id = ? AND hold_flag = 1`,
      )
      .get(normalizedUserId) as { count: number };
    const errorRow = this.db
      .prepare(
        `
        SELECT updated_at
        FROM agent_room_swarms
        WHERE user_id = ? AND status = 'error'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      )
      .get(normalizedUserId) as { updated_at?: string } | undefined;
    return {
      runningSwarms: Number(runningRow?.count || 0),
      holdSwarms: Number(holdRow?.count || 0),
      lastErrorAt: errorRow?.updated_at || null,
    };
  }
}
