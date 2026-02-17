/**
 * Persona Isolation Policy — prevents cross-persona memory leaks.
 *
 * When a user switches between personas (e.g. RolePlay "Nata" → Builder "Next.js Dev"),
 * this policy ensures that messages from one persona don't bleed into another persona's
 * memory context.
 */

export interface PersonaMessage {
  id: string;
  content: string;
  personaAtMessage: string | null | undefined;
}

export interface PersonaSwitchResult {
  switched: boolean;
  requireNewConversation: boolean;
}

export interface PersonaIsolationPolicy {
  /**
   * Checks if a persona switch has occurred since the last message.
   * If yes, a new conversation should be started.
   */
  checkPersonaSwitch(
    currentPersonaId: string,
    lastMessagePersonaId: string | null,
  ): PersonaSwitchResult;

  /**
   * Filters messages to only include those belonging to the given persona.
   * Messages without a personaAtMessage are included (legacy/untagged messages).
   */
  filterByPersona(messages: PersonaMessage[], personaId: string): PersonaMessage[];
}

/**
 * Creates a persona isolation policy instance.
 */
export function createPersonaIsolationPolicy(): PersonaIsolationPolicy {
  return {
    checkPersonaSwitch(
      currentPersonaId: string,
      lastMessagePersonaId: string | null,
    ): PersonaSwitchResult {
      if (!lastMessagePersonaId) {
        return { switched: false, requireNewConversation: false };
      }
      const switched = currentPersonaId !== lastMessagePersonaId;
      return { switched, requireNewConversation: switched };
    },

    filterByPersona(messages: PersonaMessage[], personaId: string): PersonaMessage[] {
      return messages.filter((m) => !m.personaAtMessage || m.personaAtMessage === personaId);
    },
  };
}
