import type { StoredMessage } from '@/server/channels/messages/repository';

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
      const speaker = message.role === 'agent' ? personaContext?.name || 'Assistant' : 'User';
      return `[seq:${seq}] ${speaker}: ${message.content}`;
    })
    .join('\n');

  const personaName = personaContext?.name || 'Assistant';
  const identityTerms = personaContext?.identityTerms?.join(', ') || 'die KI, die Persona';

  return [
    'Du bist ein Informationsextraktor fuer einen persoenlichen Assistenten.',
    '',
    'KONTEXT:',
    `Diese Konversation findet zwischen zwei Teilnehmern:`,
    `- "User" im Transcript = die menschliche Person (der Gespraechspartner). In events: speakerRole="user". In entities: owner="user".`,
    `- "${personaName}" im Transcript = die KI-Persona, spricht als "ich". In events: speakerRole="assistant". In entities: owner="persona".`,
    '',
    'ROLLEN-ZUORDNUNG (KRITISCH!):',
    `Wenn im Transcript "${personaName}: ..." steht → das ist die PERSONA (owner=persona, speakerRole=assistant).`,
    `Wenn im Transcript "User: ..." steht → das ist der MENSCH (owner=user, speakerRole=user).`,
    `${personaName} ist NICHT der User! ${personaName} ist die Persona/der Assistant!`,
    '',
    'WICHTIG - PERSPEKTIVE BEIBEHALTEN:',
    `${personaName} repraesentiert sich selbst als "ich". Wenn ${personaName} sagt:`,
    '  "Ich habe mit Max geschlafen" → Speichere: "Ich habe mit Max geschlafen" (owner=persona)',
    '  "Mein Bruder ist krank" → Speichere: "Mein Bruder ist krank" (owner=persona)',
    '',
    'NICHT umschreiben zu:',
    '  ❌ "Die Protagonistin hat mit Max geschlafen"',
    '  ❌ "Die KI hat mit Max geschlafen"',
    '',
    'Schema:',
    '{"facts":string[],"teaser":string,"episode":string,"meetingLedger":{"topicKey":string,"counterpart":string|null,"participants":string[],"decisions":string[],"negotiatedTerms":string[],"openPoints":string[],"actionItems":string[],"sourceRefs":[{"seq":number,"quote":string}],"confidence":number},"events":[{"eventType":string,"speakerRole":"assistant"|"user","subject":string,"counterpart":string,"relationLabel":string|null,"timeExpression":string,"dayCount":number,"isConfirmation":boolean,"confirmationSignals":string[],"sourceSeq":number[]}],"entities":[{"name":string,"category":"person"|"project"|"place"|"organization"|"concept"|"object","owner":"persona"|"user"|"shared","aliases":string[],"relations":[{"targetName":string,"relationType":string,"direction":"outgoing"|"incoming"}],"properties":Record<string,string>,"sourceSeq":number[]}]}',
    '',
    'EVENT EXTRACTION:',
    'Wenn im Gespraech konkrete Ereignisse mit Zeitbezug erwaehnt werden, extrahiere sie als events[].',
    'Bekannte eventTypes: shared_sleep, visit, trip, meeting, activity, meal, appointment, celebration, conflict, reconciliation, emotion, location_change, routine, milestone, relationship_change, health, finance',
    '- conflict: Streit, Auseinandersetzung, Meinungsverschiedenheit — z.B. "Ich hatte einen Streit mit Jonas"',
    '- reconciliation: Versöhnung nach einem Konflikt — z.B. "Wir haben uns wieder vertragen"',
    '- emotion: Starke emotionale Momente — z.B. "Ich war so traurig", "Ich habe geweint vor Freude"',
    '- relationship_change: Beziehungsaenderung — z.B. "Wir sind jetzt zusammen", "Wir haben uns getrennt"',
    '- health: Gesundheitsereignisse — z.B. "Ich war krank", "Arzttermin"',
    '- finance: Finanzentscheidungen — z.B. "Ich habe die Wohnung gekauft"',
    '- milestone: Wichtige Meilensteine — z.B. "Abschluss bestanden", "Befoerderung bekommen"',
    '- location_change: Ortswechsel/Umzug — z.B. "Ich bin nach Berlin gezogen"',
    '- routine: Wiederkehrende Gewohnheiten — z.B. "Jeden Morgen joggen"',
    `- speakerRole: Wer beschreibt das Ereignis? "assistant" wenn ${personaName} (die Persona) spricht, "user" wenn der Mensch (User) spricht.`,
    `- subject: IMMER den echten Namen verwenden, NIEMALS "Ich", "User" oder "Persona". Wenn ${personaName} sagt "Ich habe..." → subject="${personaName}". Wenn User sagt "Ich habe..." → subject="User" ist OK, aber besser den echten Namen wenn bekannt (z.B. "Meco").`,
    '- counterpart: Mit wem? (Name der anderen Person, NICHT "Ich")',
    '- relationLabel: Beziehung zum counterpart (z.B. "Bruder", "Freundin", null wenn unbekannt)',
    '- timeExpression: Originaltext des Zeitbezugs (z.B. "die letzten zwei Tage", "gestern")',
    '- dayCount: Anzahl der Tage (z.B. 2 fuer "die letzten zwei Tage")',
    '- isConfirmation: true wenn der Sprecher ein bereits bekanntes Ereignis nur bestaetigt',
    '- confirmationSignals: Bestaetigungswoerter (z.B. ["ja", "genau", "stimmt"])',
    '- sourceSeq: Array der seq-Nummern der relevanten Nachrichten',
    'Wenn keine Ereignisse vorhanden sind, gib ein leeres Array zurueck: "events":[]',
    '',
    'ENTITY EXTRACTION:',
    'Jede genannte Person, jedes Projekt, jeden Ort, jede Organisation als Entity extrahieren.',
    '- Aliase erkennen: Wenn "Max mein Bruder" gesagt wird, ist "Max" der Name und "mein Bruder"/"Bruder" sind Aliase.',
    `- owner bestimmen: Wessen Bruder? Aus dem Sprecher im Transcript ableiten. "mein Bruder" gesagt von ${personaName} → owner=persona. "mein Bruder" gesagt von User → owner=user.`,
    `- ACHTUNG: ${personaName} = die Persona (owner=persona). User = der Mensch (owner=user). NICHT verwechseln!`,
    `- Beziehungen (relations[]) zwischen Entities erkennen: "Max mein Bruder" → Entity: Max, relations: [{"targetName":"${personaName}","relationType":"bruder von","direction":"outgoing"}]`,
    '- Jede Familienbeziehung, Partnerschaft, Freundschaft, Ex-Beziehung MUSS als Relation extrahiert werden!',
    '- AUCH Ex-Partner sind Relationen! "mein Ex-Freund Paul" → Entity: Paul, relations: [{"targetName":"' +
      personaName +
      '","relationType":"ex-partner von","direction":"outgoing"}]',
    `- Relation-Richtung: relationType beschreibt die Beziehung source→target. "Max ist ${personaName}s Bruder" → Max --"bruder von"--> ${personaName}`,
    '- Eigenschaften extrahieren: "Max ist sehr nett" → Property: {"nett":"ja"}. "Die App heisst Notes2" → Property: {"projektname":"Notes2"}',
    '- Referenz-Pronomen (er, sie, es) → in benannte Entity aufloesen wenn aus Kontext klar.',
    '- Perspektiv-Pronomen (ich, mein) → in echten Entity-Namen aufloesen wenn bekannt! "mein Bruder" von User → targetName des Users.',
    'Wenn keine Entities vorhanden sind, gib ein leeres Array zurueck: "entities":[]',
    '',
    'Constraints:',
    '- teaser 80-150 woerter',
    '- episode 400-800 woerter',
    '- sourceRefs muessen echte seq referenzen enthalten',
    '- Ignoriere Begruessungen, Kommandos (z.B. /new, /persona), Systemmeldungen und UI-Metatext.',
    '- facts muessen konkrete, stabile Inhalte sein (keine Einwort-Antworten, kein Smalltalk).',
    '- Behalte die ORIGINALE Perspektive bei ("ich" bleibt "ich")',
    '- Speichere KEINE 3rd-Person-Beschreibungen der Persona',
    '- EMOTIONEN und KONFLIKTE sind wichtige Facts! Streit, Versoehnungen, starke Gefuehle IMMER als fact UND als event extrahieren.',
    '- Auch kurze Erwahnungen wie "kurzer Streit mit X, dann geklaert" sind als conflict + reconciliation events zu extrahieren.',
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
