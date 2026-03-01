export function isFeatureEnabled(name: string, defaultEnabled = true): boolean {
  const fallback = defaultEnabled ? '1' : '0';
  const normalized = String(process.env[name] ?? fallback)
    .trim()
    .toLowerCase();
  if (!normalized) return defaultEnabled;
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off';
}
