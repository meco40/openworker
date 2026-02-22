import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeGlobals = typeof globalThis & {
  __messageRepository?: unknown;
  __messageService?: unknown;
  __pollingResumeChecked?: boolean;
  __channelHealthMonitorChecked?: boolean;
  __messageRuntimeBootstrapPromise?: Promise<void>;
};

function resetRuntimeGlobals(): void {
  const globals = globalThis as RuntimeGlobals;
  globals.__messageRepository = undefined;
  globals.__messageService = undefined;
  globals.__pollingResumeChecked = undefined;
  globals.__channelHealthMonitorChecked = undefined;
  globals.__messageRuntimeBootstrapPromise = undefined;
}

function createCredentialStoreMock() {
  return {
    getCredential: vi.fn((channel: string, key: string) => {
      if (channel !== 'telegram') return '';
      if (key === 'update_transport') return 'polling';
      if (key === 'pairing_status') return 'connected';
      if (key === 'bot_token') return 'token';
      return '';
    }),
  };
}

describe('messages runtime bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    resetRuntimeGlobals();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRuntimeGlobals();
  });

  it('does not start polling or channel monitor when only getMessageService is called', async () => {
    const store = createCredentialStoreMock();
    const startTelegramPolling = vi.fn(async () => {});
    const startChannelHealthMonitor = vi.fn(() => ({ stop: vi.fn() }));

    vi.doMock('@/server/channels/messages/sqliteMessageRepository', () => ({
      SqliteMessageRepository: class SqliteMessageRepository {},
    }));
    vi.doMock('@/server/channels/messages/service', () => ({
      MessageService: class MessageService {
        constructor(_repository: unknown) {}
      },
    }));
    vi.doMock('@/server/channels/credentials', () => ({
      getCredentialStore: () => store,
    }));
    vi.doMock('@/server/channels/pairing/telegramPolling', () => ({
      startTelegramPolling,
    }));
    vi.doMock('@/server/channels/healthMonitor', () => ({
      startChannelHealthMonitor,
    }));

    const runtime = (await import('@/server/channels/messages/runtime')) as {
      getMessageService: () => unknown;
    };

    runtime.getMessageService();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(store.getCredential).not.toHaveBeenCalled();
    expect(startTelegramPolling).not.toHaveBeenCalled();
    expect(startChannelHealthMonitor).not.toHaveBeenCalled();
  });

  it('starts polling and health monitor only through explicit bootstrap and only once', async () => {
    const store = createCredentialStoreMock();
    const startTelegramPolling = vi.fn(async () => {});
    const startChannelHealthMonitor = vi.fn(() => ({ stop: vi.fn() }));

    vi.doMock('@/server/channels/messages/sqliteMessageRepository', () => ({
      SqliteMessageRepository: class SqliteMessageRepository {},
    }));
    vi.doMock('@/server/channels/messages/service', () => ({
      MessageService: class MessageService {
        constructor(_repository: unknown) {}
      },
    }));
    vi.doMock('@/server/channels/credentials', () => ({
      getCredentialStore: () => store,
    }));
    vi.doMock('@/server/channels/pairing/telegramPolling', () => ({
      startTelegramPolling,
    }));
    vi.doMock('@/server/channels/healthMonitor', () => ({
      startChannelHealthMonitor,
    }));

    const runtime = (await import('@/server/channels/messages/runtime')) as {
      bootstrapMessageRuntime: () => Promise<void>;
    };

    await runtime.bootstrapMessageRuntime();
    await runtime.bootstrapMessageRuntime();

    expect(startTelegramPolling).toHaveBeenCalledTimes(1);
    expect(startChannelHealthMonitor).toHaveBeenCalledTimes(1);
  });
});
