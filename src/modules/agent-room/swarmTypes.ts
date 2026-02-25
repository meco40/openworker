import { SWARM_PHASES, type SwarmPhase } from '@/modules/agent-room/swarmPhases';

export type SwarmStatus = 'idle' | 'running' | 'hold' | 'completed' | 'aborted' | 'error';

export interface SwarmUnit {
  personaId: string;
  role: string;
}

export interface SwarmFriction {
  level: 'low' | 'medium' | 'high';
  confidence: number;
  hold: boolean;
  reasons: string[];
  updatedAt: string;
}

export interface SwarmRecord {
  id: string;
  conversationId: string;
  userId: string;
  sessionId: string | null;
  title: string;
  task: string;
  leadPersonaId: string;
  units: SwarmUnit[];
  status: SwarmStatus;
  currentPhase: SwarmPhase;
  consensusScore: number;
  holdFlag: boolean;
  artifact: string;
  artifactHistory: string[];
  friction: SwarmFriction;
  lastSeq: number;
  currentDeployCommandId: string | null;
  searchEnabled: boolean;
  swarmTemplate: string | null;
  pauseBetweenPhases: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSwarmInput {
  title: string;
  task: string;
  leadPersonaId: string;
  units: SwarmUnit[];
  conversationId?: string;
  searchEnabled?: boolean;
  swarmTemplate?: string | null;
  pauseBetweenPhases?: boolean;
}

export interface UpdateSwarmInput {
  sessionId?: string | null;
  status?: SwarmStatus;
  currentPhase?: SwarmPhase;
  consensusScore?: number;
  holdFlag?: boolean;
  artifact?: string;
  artifactHistory?: string[];
  friction?: SwarmFriction;
  units?: SwarmUnit[];
  lastSeq?: number;
  currentDeployCommandId?: string | null;
  searchEnabled?: boolean;
  swarmTemplate?: string | null;
  pauseBetweenPhases?: boolean;
}

export function createDefaultFriction(now = new Date().toISOString()): SwarmFriction {
  return {
    level: 'low',
    confidence: 0,
    hold: false,
    reasons: [],
    updatedAt: now,
  };
}

function parseUnits(value: unknown): SwarmUnit[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const personaId = String((item as { personaId?: unknown }).personaId || '').trim();
      const role = String((item as { role?: unknown }).role || '').trim();
      if (!personaId || !role) return null;
      return { personaId, role };
    })
    .filter((item): item is SwarmUnit => Boolean(item));
}

function parseArtifactHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter((item) => item.length > 0);
}

function parseFriction(value: unknown): SwarmFriction {
  if (!value || typeof value !== 'object') {
    return createDefaultFriction();
  }
  const raw = value as Record<string, unknown>;
  const level = String(raw.level || '').trim();
  const normalizedLevel = level === 'high' || level === 'medium' || level === 'low' ? level : 'low';
  return {
    level: normalizedLevel,
    confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0,
    hold: Boolean(raw.hold),
    reasons: Array.isArray(raw.reasons)
      ? raw.reasons
          .map((reason) => String(reason || '').trim())
          .filter((reason) => reason.length > 0)
      : [],
    updatedAt: String(raw.updatedAt || '').trim() || new Date().toISOString(),
  };
}

export function parseSwarmRecord(value: unknown): SwarmRecord | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = String(raw.id || '').trim();
  const conversationId = String(raw.conversationId || raw.conversation_id || '').trim();
  const userId = String(raw.userId || raw.user_id || '').trim();
  const title = String(raw.title || '').trim();
  const task = String(raw.task || '').trim();
  const leadPersonaId = String(raw.leadPersonaId || raw.lead_persona_id || '').trim();
  if (!id || !conversationId || !userId || !title || !task || !leadPersonaId) {
    return null;
  }

  const phaseCandidate = String(raw.currentPhase || raw.current_phase || 'analysis');
  const currentPhase = (SWARM_PHASES as readonly string[]).includes(phaseCandidate)
    ? (phaseCandidate as SwarmPhase)
    : 'analysis';
  const statusCandidate = String(raw.status || 'idle');
  const status: SwarmStatus =
    statusCandidate === 'running' ||
    statusCandidate === 'hold' ||
    statusCandidate === 'completed' ||
    statusCandidate === 'aborted' ||
    statusCandidate === 'error'
      ? statusCandidate
      : 'idle';

  const units = parseUnits(raw.units ?? raw.units_json ?? []);
  const artifactHistory = parseArtifactHistory(raw.artifactHistory ?? raw.artifact_history_json);
  const friction = parseFriction(raw.friction ?? raw.friction_json);
  return {
    id,
    conversationId,
    userId,
    sessionId: raw.sessionId
      ? String(raw.sessionId)
      : raw.session_id
        ? String(raw.session_id)
        : null,
    title,
    task,
    leadPersonaId,
    units,
    status,
    currentPhase,
    consensusScore: Number.isFinite(Number(raw.consensusScore ?? raw.consensus_score))
      ? Number(raw.consensusScore ?? raw.consensus_score)
      : 0,
    holdFlag: Boolean(raw.holdFlag ?? raw.hold_flag),
    artifact: String(raw.artifact ?? raw.artifact_json ?? ''),
    artifactHistory,
    friction,
    lastSeq: Number.isFinite(Number(raw.lastSeq ?? raw.last_seq))
      ? Number(raw.lastSeq ?? raw.last_seq)
      : 0,
    currentDeployCommandId:
      (raw.currentDeployCommandId ?? raw.current_deploy_command_id)
        ? String(raw.currentDeployCommandId ?? raw.current_deploy_command_id)
        : null,
    searchEnabled: Boolean(raw.searchEnabled ?? raw.search_enabled),
    swarmTemplate:
      (raw.swarmTemplate ?? raw.swarm_template)
        ? String(raw.swarmTemplate ?? raw.swarm_template)
        : null,
    pauseBetweenPhases: Boolean(raw.pauseBetweenPhases ?? raw.pause_between_phases),
    createdAt: String(raw.createdAt ?? raw.created_at ?? ''),
    updatedAt: String(raw.updatedAt ?? raw.updated_at ?? ''),
  };
}
