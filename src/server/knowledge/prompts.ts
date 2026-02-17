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
    '{"facts":string[],"teaser":string,"episode":string,"meetingLedger":{"topicKey":string,"counterpart":string|null,"participants":string[],"decisions":string[],"negotiatedTerms":string[],"openPoints":string[],"actionItems":string[],"sourceRefs":[{"seq":number,"quote":string}],"confidence":number},"events":[{"eventType":string,"speakerRole":"assistant"|"user","subject":string,"counterpart":string,"relationLabel":string|null,"timeExpression":string,"dayCount":number,"isConfirmation":boolean,"confirmationSignals":string[],"sourceSeq":number[]}]}',
    '',
    'EVENT EXTRACTION:',
    'Wenn im Gespraech konkrete Ereignisse mit Zeitbezug erwaehnt werden, extrahiere sie als events[].',
    'Bekannte eventTypes: shared_sleep, visit, trip, meeting, activity, meal, appointment, celebration',
    '- speakerRole: Wer beschreibt das Ereignis? "assistant" wenn die Persona spricht, "user" wenn der Mensch spricht.',
    '- subject: Wer erlebt das Ereignis? (Name der Person)',
    '- counterpart: Mit wem? (Name der anderen Person)',
    '- relationLabel: Beziehung zum counterpart (z.B. "Bruder", "Freundin", null wenn unbekannt)',
    '- timeExpression: Originaltext des Zeitbezugs (z.B. "die letzten zwei Tage", "gestern")',
    '- dayCount: Anzahl der Tage (z.B. 2 fuer "die letzten zwei Tage")',
    '- isConfirmation: true wenn der Sprecher ein bereits bekanntes Ereignis nur bestaetigt',
    '- confirmationSignals: Bestaetigungswoerter (z.B. ["ja", "genau", "stimmt"])',
    '- sourceSeq: Array der seq-Nummern der relevanten Nachrichten',
    'Wenn keine Ereignisse vorhanden sind, gib ein leeres Array zurueck: "events":[]',
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
