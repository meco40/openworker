import { describe, expect, it } from 'vitest';
import type { CoupledChannel } from '../../../types';
import { buildInitialShellState } from '../../../src/modules/app-shell/useAppShellState';
import {
  COUPLED_CHANNELS_STORAGE_KEY,
  loadCoupledChannelsFromStorage,
  saveCoupledChannelsToStorage,
} from '../../../src/modules/app-shell/channelStorage';

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function createMemoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe('channel storage persistence', () => {
  const fallback = buildInitialShellState().coupledChannels;

  it('returns fallback channels when storage is empty', () => {
    const storage = createMemoryStorage();

    const loaded = loadCoupledChannelsFromStorage(storage, fallback);

    expect(loaded).toEqual(fallback);
  });

  it('loads valid persisted channel statuses and metadata', () => {
    const storage = createMemoryStorage({
      [COUPLED_CHANNELS_STORAGE_KEY]: JSON.stringify({
        telegram: {
          type: fallback.telegram.type,
          status: 'connected',
          peerName: 'telegram:123',
          connectedAt: '2026-02-10T08:45:00.000Z',
        },
      }),
    });

    const loaded = loadCoupledChannelsFromStorage(storage, fallback);

    expect(loaded.telegram.status).toBe('connected');
    expect(loaded.telegram.peerName).toBe('telegram:123');
    expect(loaded.telegram.connectedAt).toBe('2026-02-10T08:45:00.000Z');
    expect(loaded.whatsapp.status).toBe(fallback.whatsapp.status);
  });

  it('ignores malformed JSON in storage', () => {
    const storage = createMemoryStorage({
      [COUPLED_CHANNELS_STORAGE_KEY]: '{broken-json',
    });

    const loaded = loadCoupledChannelsFromStorage(storage, fallback);

    expect(loaded).toEqual(fallback);
  });

  it('saves channels to storage key', () => {
    const storage = createMemoryStorage();
    const channels: Record<string, CoupledChannel> = {
      ...fallback,
      telegram: {
        ...fallback.telegram,
        status: 'awaiting_code',
      },
    };

    saveCoupledChannelsToStorage(storage, channels);

    const raw = storage.getItem(COUPLED_CHANNELS_STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(String(raw)) as Record<string, CoupledChannel>;
    expect(parsed.telegram.status).toBe('awaiting_code');
  });
});
