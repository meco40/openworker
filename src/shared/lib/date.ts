export function toIsoDate(value: Date): string {
  return value.toISOString();
}

export function nowIso(): string {
  return toIsoDate(new Date());
}
