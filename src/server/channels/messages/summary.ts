export type SummaryMessage = { role: 'user' | 'agent' | 'system'; content: string };

export function buildFallbackSummary(previousSummary: string, messages: SummaryMessage[]): string {
  const summaryChunk = messages
    .map((message) => `[${message.role}] ${message.content.replace(/\s+/g, ' ').trim()}`)
    .join(' ')
    .slice(0, 2500);

  if (!summaryChunk) {
    return previousSummary.slice(-5000);
  }

  return previousSummary ? `${previousSummary}\n${summaryChunk}`.slice(-5000) : summaryChunk;
}

export function isAiSummaryEnabled(): boolean {
  const mode = String(process.env.CHAT_SUMMARY_MODE || 'ai').toLowerCase();
  return mode !== 'fallback' && mode !== 'concat';
}
