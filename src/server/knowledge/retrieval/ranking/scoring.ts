import { normalizeLookupText } from '../query/intentDetector';

export function computeTokenOverlapScore(text: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const normalizedText = normalizeLookupText(text);
  if (!normalizedText) return 0;
  let score = 0;
  for (const token of tokens) {
    if (normalizedText.includes(token)) score += 1;
  }
  return score;
}

/** Quick heuristic: detect emotional tone from fact text for persona strategy scoring. */
export function detectEmotionalToneInText(text: string): string | undefined {
  const lower = text.toLowerCase();
  const emotionKeywords =
    /\b(traurig|wuetend|gluecklich|freude|streit|angst|liebe|verliebt|nervoes|besorgt|aufgeregt|enttaeuscht)\b/;
  const match = lower.match(emotionKeywords);
  return match ? match[1] : undefined;
}
