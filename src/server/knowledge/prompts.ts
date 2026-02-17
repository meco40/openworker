import type { StoredMessage } from '../channels/messages/repository';

export interface KnowledgePromptInput {
  conversationId: string;
  userId: string;
  personaId: string;
  messages: StoredMessage[];
}

export interface ExtractionPersonaContext {
  name: string;
  identityTerms?: string[]; // z.B. ["Protagonistin", "die KI"]
}

export function buildKnowledgeExtractionPrompt(
  input: KnowledgePromptInput,
  personaContext?: ExtractionPersonaContext,
): string {
  const transcript = input.messages
    .map((message) => {
      const seq = Number(message.seq || 0);
      const role = message.role === 'agent' ? 'assistant' : message.role;
      return `[seq:${seq}] ${role}: ${message.content}`;
    })
    .join('\n');

  const personaName = personaContext?.name || 'Assistant';
  const identityTerms = personaContext?.identityTerms?.join(', ') || 'die KI, die Persona';

  return [
    'Du bist ein Informationsextraktor fuer einen persoenlichen Assistenten.',
    '',
    'KONTEXT:',
    `Diese Konversation findet zwischen:`,
    `- User (die menschliche Person)`,
    `- ${personaName} (die KI-Persona, spricht als "ich")`,
    '',
    'WICHTIG - PERSPEKTIVE BEIBEHALTEN:',
    'Die Persona repraesentiert sich selbst als "ich". Wenn die Persona sagt:',
    '  "Ich habe mit Max geschlafen" → Speichere: "Ich habe mit Max geschlafen"',
    '  "Mein Bruder ist krank" → Speichere: "Mein Bruder ist krank"',
    '',
    'NICHT umschreiben zu:',
    '  ❌ "Die Protagonistin hat mit Max geschlafen"',
    '  ❌ "Die KI hat mit Max geschlafen"',
    '',
    'Schema:',
    '{"facts":string[],"teaser":string,"episode":string,"meetingLedger":{"topicKey":string,"counterpart":string|null,"participants":string[],"decisions":string[],"negotiatedTerms":string[],"openPoints":string[],"actionItems":string[],"sourceRefs":[{"seq":number,"quote":string}],"confidence":number}}',
    '',
    'Constraints:',
    '- teaser 80-150 woerter',
    '- episode 400-800 woerter',
    '- sourceRefs muessen echte seq referenzen enthalten',
    '- Ignoriere Begruessungen, Kommandos (z.B. /new, /persona), Systemmeldungen und UI-Metatext.',
    '- facts muessen konkrete, stabile Inhalte sein (keine Einwort-Antworten, kein Smalltalk).',
    '- Behalte die ORIGINALE Perspektive bei ("ich" bleibt "ich")',
    '- Speichere KEINE 3rd-Person-Beschreibungen der Persona',
    '',
    `conversationId=${input.conversationId}`,
    `userId=${input.userId}`,
    `personaId=${input.personaId}`,
    `personaName=${personaName}`,
    `identityTerms=${identityTerms}`,
    'Transcript:',
    transcript,
  ].join('\n');
}
