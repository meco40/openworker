import type { Capability } from '@/server/master/execution/runtime/types';

export function toSummaryFromSearchResult(input: unknown): string {
  const normalized = input as { provider?: string; results?: Array<Record<string, unknown>> };
  const rows = Array.isArray(normalized?.results) ? normalized.results : [];
  if (!rows.length) {
    return 'No web sources returned. Generated fallback summary from task contract.';
  }
  const top = rows.slice(0, 3).map((row, index) => {
    const title = String(row.title || row.url || `Result ${index + 1}`);
    const url = String(row.url || '').trim();
    const snippet = String(row.snippet || '').trim();
    return `${index + 1}. ${title}${url ? ` (${url})` : ''}${snippet ? ` - ${snippet}` : ''}`;
  });
  return top.join('\n');
}

export function normalizeCapabilityOutput(capability: Capability, output: string): string {
  if (capability === 'code_generation') {
    return `Generated code artifact:\n${output}`;
  }
  if (capability === 'notes') {
    return `Created note:\n${output}`;
  }
  if (capability === 'reminders') {
    return `Created reminder:\n${output}`;
  }
  if (capability === 'system_ops') {
    return `System operation report:\n${output}`;
  }
  return output;
}
