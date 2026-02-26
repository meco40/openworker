import { getPersonaRepository } from '@/server/personas/personaRepository';
import { getMessageService } from '@/server/channels/messages/runtime';
import type { ResolvedSwarmUnit } from '@/shared/domain/swarmPhases';
import type { AgentRoomSwarmRecord } from '@/server/channels/messages/repository/types';
import { extractSpeakerFromPhaseBuffer } from './agentSession.service';

/**
 * Resolves persona-backed units for a swarm (de-duped, enriched with name/emoji).
 * Ensures the lead persona is always present.
 */
export function resolveSwarmUnits(swarm: AgentRoomSwarmRecord): ResolvedSwarmUnit[] {
  const personaRepo = getPersonaRepository();
  const seen = new Set<string>();
  const units: ResolvedSwarmUnit[] = [];
  for (const unit of swarm.units) {
    const personaId = String(unit.personaId || '').trim();
    if (!personaId || seen.has(personaId)) continue;
    seen.add(personaId);
    const persona = personaRepo.getPersona(personaId);
    units.push({
      personaId,
      role: unit.role,
      name: persona?.name || personaId,
      emoji: persona?.emoji || '🤖',
    });
  }

  if (!seen.has(swarm.leadPersonaId)) {
    const lead = personaRepo.getPersona(swarm.leadPersonaId);
    units.unshift({
      personaId: swarm.leadPersonaId,
      role: 'Orchestrator',
      name: lead?.name || swarm.leadPersonaId,
      emoji: lead?.emoji || '🤖',
    });
  }

  return units;
}

/**
 * Determines which persona is the current speaker.
 * Checks phase buffer first, then conversation metadata, falls back to lead.
 */
export function resolveSpeakerPersonaId(
  swarm: AgentRoomSwarmRecord,
  messageService: ReturnType<typeof getMessageService>,
): string {
  const fromBuffer = extractSpeakerFromPhaseBuffer(swarm.phaseBuffer ?? null);
  if (fromBuffer) return fromBuffer;

  const conversation = messageService.getConversation(swarm.conversationId, swarm.userId);
  if (conversation?.personaId) return conversation.personaId;
  return swarm.leadPersonaId;
}
