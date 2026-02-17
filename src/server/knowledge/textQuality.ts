function normalize(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGreetingOnly(value: string): boolean {
  return /^(hallo|hi|hey|moin|servus|ok|okay|ja|nein|danke|thx|merci)[.!?]*$/i.test(value);
}

function isCommandOrMeta(value: string): boolean {
  return (
    /^\/[a-z0-9_-]+/i.test(value) ||
    /^\s*(speichere\s+ab|save\s+memory)\b/i.test(value) ||
    /\b(neue konversation erstellt|new conversation created|persona gewechselt|switched persona)\b/i.test(
      value,
    ) ||
    /\b(gespeichert:|stored:)\b/i.test(value)
  );
}

function splitNumberedRules(value: string): string[] {
  const normalized = normalize(value);
  if (!normalized) return [];
  const header = /^(regeln?|rules?|richtlinien?|vorgaben?)\s*:\s*/i;
  const scan = normalized.replace(header, '');
  const parts = scan.split(/\s(?=\d+\s*[.)-]\s)/).map((part) => normalize(part));
  const numbered = parts.filter((part) => /^\d+\s*[.)-]\s+/.test(part));
  return numbered.length > 0 ? numbered : [normalized];
}

export function isMeaningfulKnowledgeText(value: string): boolean {
  const normalized = normalize(value);
  if (!normalized) return false;
  if (normalized.length < 8) return false;
  if (isGreetingOnly(normalized)) return false;
  if (isCommandOrMeta(normalized)) return false;

  const letters = normalized.replace(/[^a-zA-Z0-9]/g, '');
  if (letters.length < 6) return false;
  return true;
}

export function isNoiseMemoryFact(value: string): boolean {
  return !isMeaningfulKnowledgeText(value);
}

export function sanitizeKnowledgeFacts(values: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();

  for (const raw of values) {
    for (const chunk of splitNumberedRules(String(raw || ''))) {
      const normalized = normalize(chunk);
      if (!isMeaningfulKnowledgeText(normalized)) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(normalized);
    }
  }

  return output;
}

// --- Phase 3: Text Classification for Reliability ---

export type FactScope = 'real' | 'hypothetical' | 'roleplay' | 'quoted';

export interface TextClassification {
  isNegated: boolean;
  isConditional: boolean;
  isHypothetical: boolean;
  factScope: FactScope;
  factualConfidence: number;
}

const NEGATION_MARKERS = /\b(nicht|kein|keine|keinen|keinem|nie|niemals|ohne|weder)\b/i;
const CONDITIONAL_MARKERS = /\b(wenn|falls)\b/i;
const CONDITIONAL_CONSEQUENCE = /\b(dann|gehe|mache|fliege|fahre|kaufe|esse|trinke|schwimmen)\b/i;
const HYPOTHETICAL_MARKERS =
  /\b(wuerde|wuerden|koennte|koennten|haette|haetten|wuensche|traeume)\b/i;
const ROLEPLAY_MARKERS =
  /\b(stell dir vor|lass uns so tun|in character|ooc|ic:|im spiel|fantasy|szenario)\b/i;
const QUOTE_MARKERS = /\b(hat gesagt|meinte|sagte|laut|zitat)\b/i;

export function classifyTextReliability(text: string): TextClassification {
  const isNegated = NEGATION_MARKERS.test(text);
  const isConditional = CONDITIONAL_MARKERS.test(text) && CONDITIONAL_CONSEQUENCE.test(text);
  const isHypothetical = HYPOTHETICAL_MARKERS.test(text);
  const isRoleplay = ROLEPLAY_MARKERS.test(text);
  const isQuoted = QUOTE_MARKERS.test(text);

  let factScope: FactScope = 'real';
  if (isRoleplay) factScope = 'roleplay';
  else if (isQuoted) factScope = 'quoted';
  else if (isHypothetical || isConditional) factScope = 'hypothetical';

  let factualConfidence = 1.0;
  if (isRoleplay) factualConfidence = 0.1;
  else if (isHypothetical) factualConfidence = 0.2;
  else if (isConditional) factualConfidence = 0.4;
  else if (isQuoted) factualConfidence = 0.5;
  else if (isNegated) factualConfidence = 0.7;

  return { isNegated, isConditional, isHypothetical, factScope, factualConfidence };
}

// --- Phase 3: Temporal Status Detection ---

export type TemporalStatus = 'current' | 'past' | 'planned' | 'unknown';

export function detectTemporalStatus(text: string): TemporalStatus {
  // Explicit past markers — highest priority
  if (/\b(frueher|damals|ehemals|ehemalig|war\s+mal|habe\s+mal)\b/i.test(text)) return 'past';

  // Future / planned
  if (/\b(werde|werden|naechste|naechsten|morgen|demnaechst|bald|plane|vorhabe)\b/i.test(text))
    return 'planned';

  // Present tense indicators (only if no past indicators present)
  if (
    /\b(bin|ist|arbeite|wohne|habe|mag|liebe|heisse)\b/i.test(text) &&
    !/\b(war|hatte|habe\s+\w+t)\b/i.test(text)
  )
    return 'current';

  return 'unknown';
}
