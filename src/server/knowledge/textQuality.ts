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
