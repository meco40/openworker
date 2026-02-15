export function estimateTokenCount(text: string): number {
  const bytes = Buffer.byteLength(String(text || ''), 'utf8');
  if (bytes <= 0) return 0;
  return Math.max(1, Math.ceil(bytes / 4));
}

export function trimToTokenBudget(text: string, maxTokens: number): string {
  const normalized = String(text || '').trim();
  if (!normalized) return '';
  if (maxTokens <= 0) return '';

  const words = normalized.split(/\s+/).filter(Boolean);
  const output: string[] = [];

  for (const word of words) {
    const next = output.length === 0 ? word : `${output.join(' ')} ${word}`;
    if (estimateTokenCount(next) > maxTokens) break;
    output.push(word);
  }

  return output.join(' ');
}

export function enforceSectionBudgets<T extends Record<string, string>>(
  sections: T,
  maxTokens: number,
  weights: Record<keyof T, number>,
): T {
  const normalizedMax = Math.max(1, Math.floor(maxTokens));
  const output = { ...sections };

  let totalWeight = 0;
  for (const key of Object.keys(sections) as Array<keyof T>) {
    totalWeight += Math.max(0, Number(weights[key] || 0));
  }
  if (totalWeight <= 0) totalWeight = 1;

  for (const key of Object.keys(sections) as Array<keyof T>) {
    const sectionWeight = Math.max(0, Number(weights[key] || 0));
    const budget = Math.max(1, Math.floor((normalizedMax * sectionWeight) / totalWeight));
    output[key] = trimToTokenBudget(sections[key], budget) as T[keyof T];
  }

  return output;
}
