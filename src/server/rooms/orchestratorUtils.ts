import type { GatewayMessage } from '@/server/model-hub/Models/types';
import { resolveRoomRouting } from '@/server/rooms/service';
import type { RoomMember, RoomMessage } from '@/server/rooms/types';

export interface RoutableMember {
  personaId: string;
  model: string;
  profileId: string;
}

interface RuntimeRepositoryLike {
  getMemberRuntime(roomId: string, personaId: string): { status: string } | null;
}

export function resolveRoutableMembers(
  repository: RuntimeRepositoryLike,
  members: RoomMember[],
  roomId: string,
  roomProfileId: string,
  activeModelsByProfile: Record<string, string[]>,
): { routableMembers: RoutableMember[]; validMembers: RoutableMember[] } {
  const routableMembers: RoutableMember[] = [];
  const validMembers: RoutableMember[] = [];

  for (const member of members) {
    const resolved = resolveRoomRouting({
      roomProfileId,
      memberModelOverride: member.modelOverride,
      activeModelsByProfile,
    });
    if (!resolved.model || !resolved.profileId) {
      continue;
    }

    const candidate = {
      personaId: member.personaId,
      model: resolved.model,
      profileId: resolved.profileId,
    };
    routableMembers.push(candidate);

    const runtime = repository.getMemberRuntime(roomId, member.personaId);
    if (runtime?.status !== 'paused') {
      validMembers.push(candidate);
    }
  }

  return { routableMembers, validMembers };
}

export function selectNextSpeaker(
  validMembers: RoutableMember[],
  lastSpeakerId: string | null,
): RoutableMember | null {
  if (validMembers.length === 0) return null;
  if (!lastSpeakerId) return validMembers[0]!;

  const lastIndex = validMembers.findIndex((member) => member.personaId === lastSpeakerId);
  const nextIndex = (lastIndex + 1) % validMembers.length;
  return validMembers[nextIndex]!;
}

export function buildPersonaNameMap(
  members: RoomMember[],
  personaLookup: (personaId: string) => { name: string } | null,
): Map<string, string> {
  const personaNameMap = new Map<string, string>();
  for (const member of members) {
    const persona = personaLookup(member.personaId);
    personaNameMap.set(member.personaId, persona?.name || member.personaId);
  }
  return personaNameMap;
}

type HistoryEntry = Pick<RoomMessage, 'speakerType' | 'speakerPersonaId' | 'content'>;

export function buildGatewayHistoryMessages(
  recentMessages: HistoryEntry[],
  selectedPersonaId: string,
  personaNameMap: Map<string, string>,
): GatewayMessage[] {
  const gatewayMessages: GatewayMessage[] = [];
  for (const message of recentMessages) {
    const isOwnMessage =
      message.speakerType === 'persona' && message.speakerPersonaId === selectedPersonaId;

    let content = message.content;
    if (message.speakerType === 'persona' && message.speakerPersonaId && !isOwnMessage) {
      const name = personaNameMap.get(message.speakerPersonaId) || message.speakerPersonaId;
      content = `[${name}]: ${message.content}`;
    } else if (message.speakerType === 'user') {
      content = `[User]: ${message.content}`;
    } else if (message.speakerType === 'system') {
      content = `[System]: ${message.content}`;
    }

    gatewayMessages.push({
      role: isOwnMessage ? 'assistant' : 'user',
      content,
    });
  }
  return gatewayMessages;
}

export function buildSystemPromptParts(input: {
  systemInstruction: string | null;
  persona: { name: string; vibe: string } | null;
  roomDescription: string | null;
}): string[] {
  const systemParts: string[] = [];
  if (input.systemInstruction) {
    systemParts.push(input.systemInstruction);
  } else if (input.persona) {
    const fallback = [`Dein Name ist "${input.persona.name}".`];
    if (input.persona.vibe) fallback.push(`Vibe: ${input.persona.vibe}`);
    systemParts.push(fallback.join(' '));
  }

  if (input.roomDescription) {
    systemParts.push(`---\nKontext: ${input.roomDescription}\n---`);
  }
  systemParts.push('Du bist in einer Gruppendiskussion. Antworte nur als du selbst.');
  return systemParts;
}

export function seedGatewayMessagesIfEmpty(
  gatewayMessages: GatewayMessage[],
  previousSummary: string | null,
  roomDescription: string | null,
): void {
  if (gatewayMessages.length > 0) return;
  if (previousSummary) {
    gatewayMessages.push({ role: 'user', content: `Context summary:\n${previousSummary}` });
    return;
  }
  gatewayMessages.push({
    role: 'user',
    content: roomDescription || 'Beginne die Diskussion.',
  });
}

export function stripSpeakerPrefix(content: string): string {
  return content.replace(/^\[[^\]]{1,30}\]:\s*/g, '').trim();
}
