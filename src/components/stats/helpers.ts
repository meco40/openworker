export function formatNumber(n: number): string {
  return n.toLocaleString('de-DE');
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function truncateModel(name: string, max = 28): string {
  return name.length > max ? `${name.slice(0, max)}…` : name;
}

export const CHART_COLORS = [
  '#8b5cf6',
  '#6366f1',
  '#a78bfa',
  '#818cf8',
  '#c084fc',
  '#7c3aed',
  '#4f46e5',
  '#7e22ce',
  '#6d28d9',
  '#5b21b6',
  '#4c1d95',
  '#312e81',
];
