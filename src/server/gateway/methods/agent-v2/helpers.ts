import type { AgentRoomSwarmUnit } from '@/server/channels/messages/repository';
import { getMessageRepository } from '@/server/channels/messages/runtime';
import { AgentV2Error } from '@/server/agent-v2/errors';
import { getPersonaRepository } from '@/server/personas/personaRepository';

export const MAX_TITLE_CHARS = 160;
export const MAX_TASK_CHARS = 8_000;
export const MAX_GUIDANCE_CHARS = 2_000;
export const MAX_UNITS = 12;
export const MAX_UNITS_JSON_CHARS = 16_000;

export function requiredString(params: Record<string, unknown>, key: string): string {
  const value = String(params[key] || '').trim();
  if (!value) throw new AgentV2Error(`${key} is required`, 'INVALID_REQUEST');
  return value;
}

export function requiredBoundedString(
  params: Record<string, unknown>,
  key: string,
  maxChars: number,
): string {
  const value = requiredString(params, key);
  if (value.length > maxChars) {
    throw new AgentV2Error(`${key} exceeds max size (${maxChars}).`, 'INVALID_REQUEST');
  }
  return value;
}

export function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = String(params[key] || '').trim();
  return value || undefined;
}

export function optionalBoundedString(
  params: Record<string, unknown>,
  key: string,
  maxChars: number,
): string | undefined {
  const value = optionalString(params, key);
  if (!value) return undefined;
  if (value.length > maxChars) {
    throw new AgentV2Error(`${key} exceeds max size (${maxChars}).`, 'INVALID_REQUEST');
  }
  return value;
}

export function requiredBoolean(params: Record<string, unknown>, key: string): boolean {
  if (!(key in params)) throw new AgentV2Error(`${key} is required`, 'INVALID_REQUEST');
  return Boolean(params[key]);
}

export function parseUnits(params: Record<string, unknown>, key: string): AgentRoomSwarmUnit[] {
  const value = params[key];
  if (!Array.isArray(value)) throw new AgentV2Error(`${key} must be an array`, 'INVALID_REQUEST');
  const units = value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const personaId = String((item as { personaId?: unknown }).personaId || '').trim();
      const role = String((item as { role?: unknown }).role || '').trim();
      if (!personaId || !role) return null;
      return { personaId, role };
    })
    .filter((item): item is AgentRoomSwarmUnit => Boolean(item));

  if (units.length === 0) {
    throw new AgentV2Error(`${key} must contain at least one valid unit`, 'INVALID_REQUEST');
  }
  if (units.length > MAX_UNITS) {
    throw new AgentV2Error(`Too many swarm units (max ${MAX_UNITS}).`, 'INVALID_REQUEST');
  }
  if (JSON.stringify(units).length > MAX_UNITS_JSON_CHARS) {
    throw new AgentV2Error('Units payload too large.', 'INVALID_REQUEST');
  }
  return units;
}

export function distinctPersonaIds(units: AgentRoomSwarmUnit[]): string[] {
  return Array.from(
    new Set(units.map((unit) => String(unit.personaId || '').trim()).filter(Boolean)),
  );
}

export function ensurePersonaExists(personaId: string): void {
  const persona = getPersonaRepository().getPersona(personaId);
  if (!persona) throw new AgentV2Error(`Persona not found: ${personaId}`, 'INVALID_REQUEST');
}

export function assertAgentRoomEnabled(): void {
  const enabled = String(process.env.AGENT_ROOM_ENABLED || 'true').toLowerCase() === 'true';
  if (!enabled) {
    throw new AgentV2Error('Agent Room is disabled by server configuration.', 'UNAVAILABLE');
  }
}

export function getSwarmRepository() {
  const repo = getMessageRepository();
  if (!repo.createAgentRoomSwarm) {
    throw new AgentV2Error('Agent Room swarm persistence is unavailable.', 'UNAVAILABLE');
  }
  return repo;
}
