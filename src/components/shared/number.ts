export function parsePositiveInt(rawValue: string, fallback: number): number {
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
