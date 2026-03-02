import { parsePositiveInt } from '@/components/shared/number';

export function createLocalUuid(): string {
  const raw =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replaceAll('-', '').toUpperCase()
      : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.toUpperCase();

  const padded = `${raw}000000000000`;
  return `OC-${padded.slice(0, 4)}-${padded.slice(4, 8)}-${padded.slice(8, 13)}`;
}

export { parsePositiveInt };
