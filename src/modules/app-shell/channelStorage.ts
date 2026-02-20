import type { CoupledChannel } from '@/shared/domain/types';

export const COUPLED_CHANNELS_STORAGE_KEY = 'openclaw.coupledChannels.v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const VALID_STATUSES: ReadonlySet<CoupledChannel['status']> = new Set([
  'idle',
  'pairing',
  'awaiting_code',
  'connected',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function parseStoredStatus(value: unknown): CoupledChannel['status'] | null {
  if (typeof value !== 'string') return null;
  if (!VALID_STATUSES.has(value as CoupledChannel['status'])) return null;
  return value as CoupledChannel['status'];
}

export function loadCoupledChannelsFromStorage(
  storage: StorageLike | null,
  fallback: Record<string, CoupledChannel>,
): Record<string, CoupledChannel> {
  if (!storage) return fallback;

  try {
    const raw = storage.getItem(COUPLED_CHANNELS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return fallback;

    const restored: Record<string, CoupledChannel> = { ...fallback };
    for (const key of Object.keys(fallback)) {
      const entry = parsed[key];
      if (!isRecord(entry)) continue;

      const status = parseStoredStatus(entry.status);
      if (!status) continue;

      const next: CoupledChannel = {
        ...fallback[key],
        status,
      };
      if (typeof entry.peerName === 'string') {
        next.peerName = entry.peerName;
      } else {
        delete next.peerName;
      }
      if (typeof entry.connectedAt === 'string') {
        next.connectedAt = entry.connectedAt;
      } else {
        delete next.connectedAt;
      }
      restored[key] = next;
    }
    return restored;
  } catch {
    return fallback;
  }
}

export function saveCoupledChannelsToStorage(
  storage: StorageLike | null,
  channels: Record<string, CoupledChannel>,
): void {
  if (!storage) return;
  try {
    storage.setItem(COUPLED_CHANNELS_STORAGE_KEY, JSON.stringify(channels));
  } catch {
    // Ignore storage write failures (private mode, quota, etc.)
  }
}
