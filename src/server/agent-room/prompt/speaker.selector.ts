import type { SpeakerSelectionParams } from '@/server/agent-room/types';

export function chooseNextSpeakerPersonaId(params: SpeakerSelectionParams): string {
  const turnCount = Math.max(0, Math.floor(params.turnCount || 0));
  const leadPersonaId = String(params.leadPersonaId || '').trim();
  const orderedPersonaIds: string[] = [];
  const seen = new Set<string>();

  if (leadPersonaId) {
    orderedPersonaIds.push(leadPersonaId);
    seen.add(leadPersonaId);
  }

  for (const unit of params.units) {
    const personaId = String(unit.personaId || '').trim();
    if (!personaId || seen.has(personaId)) continue;
    orderedPersonaIds.push(personaId);
    seen.add(personaId);
  }

  if (orderedPersonaIds.length === 0) return '';
  return orderedPersonaIds[turnCount % orderedPersonaIds.length] || orderedPersonaIds[0];
}
