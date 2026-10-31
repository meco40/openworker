import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore } from '@/server/channels/credentials/credentialStore';
import {
  isTelegramPollingActive,
  startTelegramPolling,
  stopTelegramPolling,
} from '@/server/channels/pairing/telegramPolling';
import type { MockProcedure } from '../../helpers/mockProcedure';

const processTelegramInboundUpdate = vi.hoisted(() => vi.fn<MockProcedure>());
vi.mock('@/server/channels/pairing/telegramInbound', () => ({ processTelegramInboundUpdate }));

type PollingGlobals = typeof globalThis & {
  __credentialStore?: CredentialStore;
  __telegramPollingTimer?: ReturnType<typeof setTimeout>;
  __telegramPollingActive?: boolean;
  __telegramPollingInstanceId?: string;
  __telegramPollingConflictUntilMs?: number;
  __telegramPollingStandbyTimer?: ReturnType<typeof setTimeout>;
};

function resetPollingGlobals(): void {
  const globals = globalThis as PollingGlobals;
  if (globals.__telegramPollingTimer) {
    clearTimeout(globals.__telegramPollingTimer);
  }
  if (globals.__telegramPollingStandbyTimer) {
    clearTimeout(globals.__telegramPollingStandbyTimer);
  }
  globals.__telegramPollingStandbyTimer = undefined;
  globals.__telegramPollingTimer = undefined;
  globals.__telegramPollingActive = false;
  globals.__telegramPollingInstanceId = undefined;
  globals.__telegramPollingConflictUntilMs = undefined;
}

describe('telegram polling lease coordination', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    const globals = globalThis as PollingGlobals;
    globals.__credentialStore = new CredentialStore(':memory:');
    resetPollingGlobals();
    globals.__credentialStore.setCredential('telegram', 'bot_token', 'bot-token');
    globals.__credentialStore.setCredential('telegram', 'update_transport', 'polling');
  });

  afterEach(() => {
    stopTelegramPolling();
    resetPollingGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not start when another runtime holds a valid polling lease', async () => {
    const store = (globalThis as PollingGlobals).__credentialStore!;
    store.setCredential('telegram', 'polling_owner', 'other-runtime');
    store.setCredential(
      'telegram',
      'polling_lease_until',
      new Date(Date.now() + 60_000).toISOString(),
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await startTelegramPolling();

    expect(isTelegramPollingActive()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('takes over polling once a stale lease from a dead runtime expires', async () => {
    const store = (globalThis as PollingGlobals).__credentialStore!;
    store.setCredential('telegram', 'polling_owner', 'dead-runtime');
    store.setCredential(
      'telegram',
      'polling_lease_until',
      new Date(Date.now() + 10_000).toISOString(),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }),
    );

    await startTelegramPolling();
    expect(isTelegramPollingActive()).toBe(false);

    await vi.advanceTimersByTimeAsync(20_000);

    expect(isTelegramPollingActive()).toBe(true);
  });

  it('does not retry after an explicit stop', async () => {
    const store = (globalThis as PollingGlobals).__credentialStore!;
    store.setCredential('telegram', 'polling_owner', 'other-runtime');
    store.setCredential(
      'telegram',
      'polling_lease_until',
      new Date(Date.now() + 5_000).toISOString(),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }),
    );

    await startTelegramPolling();
    stopTelegramPolling();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(isTelegramPollingActive()).toBe(false);
  });

  it('persists the offset before a long-running update finishes', async () => {
    const store = (globalThis as PollingGlobals).__credentialStore!;
    processTelegramInboundUpdate.mockReturnValue(new Promise(() => {}));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: [
              { update_id: 41, message: { message_id: 1, chat: { id: 1, type: 'private' } } },
            ],
          }),
          { status: 200 },
        ),
      );

    await startTelegramPolling();
    await vi.advanceTimersByTimeAsync(2_200);

    expect(processTelegramInboundUpdate).toHaveBeenCalledTimes(1);
    expect(store.getCredential('telegram', 'polling_offset')).toBe('42');
  });

  it('stops and releases lease when Telegram responds with 409 conflict', async () => {
    const store = (globalThis as PollingGlobals).__credentialStore!;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 409 }));

    await startTelegramPolling();
    expect(isTelegramPollingActive()).toBe(true);

    await vi.advanceTimersByTimeAsync(2_200);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(isTelegramPollingActive()).toBe(false);
    expect(store.getCredential('telegram', 'polling_owner')).toBeNull();
    expect(store.getCredential('telegram', 'polling_lease_until')).toBeNull();
  });
});
