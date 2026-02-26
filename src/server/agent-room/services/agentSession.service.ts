import type { AgentSession, PhaseBufferEntry } from '@/server/agent-room/types';

export function parseAgentSessions(phaseBuffer: PhaseBufferEntry[]): AgentSession[] {
  return phaseBuffer
    .filter(
      (entry): entry is PhaseBufferEntry & { type: 'agentsession' } =>
        entry.type === 'agentsession',
    )
    .map((entry) => ({
      personaId: entry.personaId,
      sessionId: entry.sessionId,
      lastSeq: entry.lastSeq,
    }));
}

export function getAgentSessionEntry(
  phaseBuffer: PhaseBufferEntry[],
  personaId: string,
): AgentSession | null {
  const sessions = parseAgentSessions(phaseBuffer);
  return sessions.find((s) => s.personaId === personaId) ?? null;
}

export function updatePhaseBufferSessions(
  phaseBuffer: PhaseBufferEntry[],
  updated: AgentSession,
): PhaseBufferEntry[] {
  const result: PhaseBufferEntry[] = [];
  let found = false;
  for (const entry of phaseBuffer) {
    if (entry.type === 'agentsession' && entry.personaId === updated.personaId) {
      result.push({
        type: 'agentsession',
        personaId: updated.personaId,
        sessionId: updated.sessionId,
        lastSeq: updated.lastSeq,
      });
      found = true;
    } else {
      result.push(entry);
    }
  }
  if (!found) {
    result.push({
      type: 'agentsession',
      personaId: updated.personaId,
      sessionId: updated.sessionId,
      lastSeq: updated.lastSeq,
    });
  }
  return result;
}

export function extractSpeakerFromPhaseBuffer(
  phaseBuffer: PhaseBufferEntry[] | null,
): string | null {
  if (!Array.isArray(phaseBuffer)) return null;
  const marker = phaseBuffer.find(
    (entry): entry is PhaseBufferEntry & { type: 'speaker' } => entry.type === 'speaker',
  );
  return marker?.personaId ?? null;
}
