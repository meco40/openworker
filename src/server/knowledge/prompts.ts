import type { StoredMessage } from '../channels/messages/repository';

export interface KnowledgePromptInput {
  conversationId: string;
  userId: string;
  personaId: string;
  messages: StoredMessage[];
}

export function buildKnowledgeExtractionPrompt(input: KnowledgePromptInput): string {
  const transcript = input.messages
    .map((message) => {
      const seq = Number(message.seq || 0);
      const role = message.role === 'agent' ? 'assistant' : message.role;
      return `[seq:${seq}] ${role}: ${message.content}`;
    })
    .join('\n');

  return [
    'Du bist ein strikt deterministischer Informationsextraktor.',
    'Antworte ausschliesslich als JSON ohne Markdown und ohne Zusatztext.',
    'Schema:',
    '{"facts":string[],"teaser":string,"episode":string,"meetingLedger":{"topicKey":string,"counterpart":string|null,"participants":string[],"decisions":string[],"negotiatedTerms":string[],"openPoints":string[],"actionItems":string[],"sourceRefs":[{"seq":number,"quote":string}],"confidence":number}}',
    'Constraints:',
    '- teaser 80-150 woerter',
    '- episode 400-800 woerter',
    '- sourceRefs muessen echte seq referenzen enthalten',
    '',
    `conversationId=${input.conversationId}`,
    `userId=${input.userId}`,
    `personaId=${input.personaId}`,
    'Transcript:',
    transcript,
  ].join('\n');
}
