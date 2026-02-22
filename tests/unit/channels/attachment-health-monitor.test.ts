import { afterEach, describe, expect, it, vi } from 'vitest';

const auditMock = vi.fn();
const logMock = vi.fn();

vi.mock('@/server/channels/messages/attachmentConsistency', () => ({
  runAttachmentConsistencyAudit: (...args: unknown[]) => auditMock(...args),
}));

vi.mock('@/logging/logService', () => ({
  log: (...args: unknown[]) => logMock(...args),
}));

describe('attachment health monitor', () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    const mod = await import('@/server/channels/messages/attachmentHealthMonitor');
    mod.stopAttachmentHealthMonitorForTests();
  });

  it('creates warning alarm entries for missing files', async () => {
    const mod = await import('@/server/channels/messages/attachmentHealthMonitor');
    const entries = mod.evaluateAttachmentHealthSnapshot(
      { missingFiles: 2, bucketMismatches: 0 },
      { missingFiles: 0, bucketMismatches: 0 },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('warn');
    expect(entries[0]?.message).toBe('attachments.consistency.alert');
  });

  it('creates recovery info entry after previous issue', async () => {
    const mod = await import('@/server/channels/messages/attachmentHealthMonitor');
    const entries = mod.evaluateAttachmentHealthSnapshot(
      { missingFiles: 0, bucketMismatches: 0 },
      { missingFiles: 3, bucketMismatches: 1 },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('info');
    expect(entries[0]?.message).toBe('attachments.consistency.recovered');
  });

  it('logs monitor failure only once per repeating error fingerprint', async () => {
    vi.useFakeTimers();
    auditMock.mockImplementation(() => {
      throw new Error('boom');
    });

    const mod = await import('@/server/channels/messages/attachmentHealthMonitor');
    mod.startAttachmentHealthMonitor();
    vi.advanceTimersByTime(16 * 60 * 1000);

    const errorCalls = logMock.mock.calls.filter(
      (call) => call[0] === 'error' && call[2] === 'attachments.consistency.monitor_failed',
    );
    expect(errorCalls).toHaveLength(1);
  });
});
