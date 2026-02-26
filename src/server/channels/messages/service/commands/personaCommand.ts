import type { ChannelType } from '@/shared/domain/types';
import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import {
  getChannelBindingPersonaId,
  setChannelBindingPersona,
} from '@/server/channels/messages/channelBindingPersona';
import type { CommandHandlerDeps } from './types';

export async function handlePersonaCommand(
  conversation: Conversation,
  payload: string,
  platform: ChannelType,
  externalChatId: string,
  repo: {
    updatePersonaId: (id: string, personaId: string | null, userId: string) => void;
  },
  sendResponse: CommandHandlerDeps['sendResponse'],
): Promise<StoredMessage> {
  const lower = payload.toLowerCase().trim();

  // Load persona repository
  let personaRepo: ReturnType<typeof getPersonaRepository>;
  try {
    personaRepo = getPersonaRepository();
  } catch {
    return sendResponse(
      conversation,
      '⚠️ Persona-System nicht verfügbar.',
      platform,
      externalChatId,
    );
  }

  const personas = personaRepo.listPersonas(conversation.userId);

  // /persona (no args) → show current + help
  if (!lower) {
    const currentPersonaId = getChannelBindingPersonaId(repo, conversation.userId, platform);
    const currentPersona = currentPersonaId ? personaRepo.getPersona(currentPersonaId) : null;

    const lines = [
      '🎭 **Persona-System**',
      '',
      currentPersona
        ? `Aktive Persona: ${currentPersona.emoji} **${currentPersona.name}**`
        : 'Keine Persona aktiv (Default-Modus)',
      '',
      '**Befehle:**',
      '`/persona list` — Alle Personas anzeigen',
      '`/persona <Name>` — Persona wechseln',
      '`/persona off` — Persona deaktivieren',
    ];
    return sendResponse(conversation, lines.join('\n'), platform, externalChatId);
  }

  // /persona list → list all personas
  if (lower === 'list') {
    if (personas.length === 0) {
      return sendResponse(
        conversation,
        '🎭 Keine Personas erstellt.\nErstelle Personas in der WebApp unter "Agent Personas".',
        platform,
        externalChatId,
      );
    }

    const currentPersonaId = getChannelBindingPersonaId(repo, conversation.userId, platform);
    const lines = ['🎭 **Verfügbare Personas:**', ''];
    for (const p of personas) {
      const active = p.id === currentPersonaId ? ' ✓' : '';
      const vibe = p.vibe ? ` — _${p.vibe}_` : '';
      lines.push(`${p.emoji} **${p.name}**${vibe}${active}`);
    }
    lines.push('', 'Wechseln: `/persona <Name>`');
    return sendResponse(conversation, lines.join('\n'), platform, externalChatId);
  }

  // /persona off|clear|default → deactivate
  if (lower === 'off' || lower === 'clear' || lower === 'default') {
    setChannelBindingPersona(repo, conversation.userId, platform, null);
    // Also clear on current conversation
    repo.updatePersonaId(conversation.id, null, conversation.userId);
    return sendResponse(
      conversation,
      '🎭 Persona deaktiviert. Du chattest jetzt im Default-Modus.',
      platform,
      externalChatId,
    );
  }

  // /persona <name> → fuzzy match by name
  const match = personas.find(
    (p) => p.name.toLowerCase() === lower || p.name.toLowerCase().startsWith(lower),
  );

  if (!match) {
    const available = personas.map((p) => `${p.emoji} ${p.name}`).join(', ');
    return sendResponse(
      conversation,
      `⚠️ Persona "${payload}" nicht gefunden.\nVerfügbar: ${available || '(keine)'}`,
      platform,
      externalChatId,
    );
  }

  // Apply persona to channel binding + current conversation
  setChannelBindingPersona(repo, conversation.userId, platform, match.id);
  repo.updatePersonaId(conversation.id, match.id, conversation.userId);

  return sendResponse(
    conversation,
    `🎭 Persona gewechselt: ${match.emoji} **${match.name}**\nAlle neuen Nachrichten in ${platform} nutzen jetzt diese Persona.`,
    platform,
    externalChatId,
  );
}
