import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LogRepository } from '../../../src/server/telemetry/logRepository';

vi.mock('../../../src/server/channels/sse/manager', () => ({
  getSSEManager: () => ({
    broadcast: vi.fn(),
    addClient: vi.fn(),
    removeClient: vi.fn(),
  }),
}));

describe('omnichannel observability contract', () => {
  let repo: LogRepository;

  beforeEach(() => {
    repo = new LogRepository(':memory:');
    globalThis.__logRepository = repo;
  });

  afterEach(() => {
    repo.close();
    globalThis.__logRepository = undefined;
  });

  it('emits structured channel telemetry log entries', async () => {
    const { logChannelEvent } = await import('../../../src/server/telemetry/logService');

    logChannelEvent('inbound', 'telegram', 'accepted', { latencyMs: 7 });
    logChannelEvent('outbound', 'slack', 'failed', { reason: 'token_invalid' });

    const logs = repo.listLogs();
    expect(logs).toHaveLength(2);
    expect(logs[0].message).toContain('channel.inbound.accepted:telegram');
    expect(logs[0].level).toBe('info');
    expect(logs[1].message).toContain('channel.outbound.failed:slack');
    expect(logs[1].level).toBe('error');
  });
});
