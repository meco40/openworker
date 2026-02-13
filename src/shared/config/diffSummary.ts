import { getFieldMetadata, type ConfigFieldRisk } from './fieldMetadata';

export interface DiffItem {
  path: string;
  before: unknown;
  after: unknown;
  risk: ConfigFieldRisk;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walkDiff(before: unknown, after: unknown, basePath: string, out: DiffItem[]): void {
  if (Object.is(before, after)) {
    return;
  }

  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const path = basePath ? `${basePath}.${key}` : key;
      walkDiff(before[key], after[key], path, out);
    }
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    if (JSON.stringify(before) === JSON.stringify(after)) {
      return;
    }
  }

  const metadata = getFieldMetadata(basePath);
  out.push({
    path: basePath,
    before,
    after,
    risk: metadata?.risk ?? 'safe',
  });
}

export function summarizeConfigDiff(before: unknown, after: unknown): DiffItem[] {
  const items: DiffItem[] = [];
  walkDiff(before, after, '', items);
  return items
    .filter((item) => item.path.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function hasHighRiskDiff(items: DiffItem[]): boolean {
  return items.some((item) => item.risk === 'restart-required' || item.risk === 'sensitive');
}
