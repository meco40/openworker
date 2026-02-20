import { afterEach, describe, expect, it, vi } from 'vitest';

import { LogRepository } from '../../../src/logging/logRepository';

type MockHealthCheck = {
  id: string;
  category: 'core' | 'security' | 'integration' | 'diagnostics';
  status: 'ok' | 'warning' | 'critical' | 'skipped';
  message: string;
  latencyMs: number;
  details?: Record<string, unknown>;
};

function mockHealth(checks: MockHealthCheck[], status: 'ok' | 'degraded' | 'critical' = 'ok') {
  return {
    runHealthCommand: vi.fn().mockResolvedValue({
      status,
      checks,
      summary: { ok: 0, warning: 0, critical: 0, skipped: 0 },
      generatedAt: '2026-02-11T00:00:00.000Z',
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  globalThis.__logRepository = undefined;
});

describe('runDoctorCommand', () => {
  it('promotes security critical checks to critical findings', async () => {
    vi.doMock('../../../src/commands/healthCommand', () =>
      mockHealth(
        [
          {
            id: 'security.snapshot',
            category: 'security',
            status: 'critical',
            message: 'Security snapshot contains critical findings.',
            latencyMs: 2,
            details: { summary: { critical: 1 } },
          },
        ],
        'critical',
      ),
    );

    const { runDoctorCommand } = await import('../../../src/commands/doctorCommand');
    const report = await runDoctorCommand();

    expect(report.status).toBe('critical');
    expect(report.findings.some((finding) => finding.id === 'security_critical')).toBe(true);
  });

  it('creates warning finding for bridge health issues', async () => {
    vi.doMock('../../../src/commands/healthCommand', () =>
      mockHealth(
        [
          {
            id: 'integration.whatsapp_bridge',
            category: 'integration',
            status: 'warning',
            message: 'Bridge health failed with 503.',
            latencyMs: 10,
          },
        ],
        'degraded',
      ),
    );

    const { runDoctorCommand } = await import('../../../src/commands/doctorCommand');
    const report = await runDoctorCommand();

    expect(report.status).toBe('degraded');
    expect(report.findings.some((finding) => finding.id === 'bridge_unreachable')).toBe(true);
  });

  it('creates warning finding for security snapshot warnings', async () => {
    vi.doMock('../../../src/commands/healthCommand', () =>
      mockHealth(
        [
          {
            id: 'security.snapshot',
            category: 'security',
            status: 'warning',
            message: 'Security snapshot contains warnings.',
            latencyMs: 5,
            details: { summary: { warning: 1, critical: 0 } },
          },
        ],
        'degraded',
      ),
    );

    const { runDoctorCommand } = await import('../../../src/commands/doctorCommand');
    const report = await runDoctorCommand();

    expect(report.status).toBe('degraded');
    expect(report.findings.some((finding) => finding.id === 'security_warning')).toBe(true);
    expect(report.recommendations.length).toBeGreaterThan(0);
  });

  it('detects an error spike from logs within the last 15 minutes', async () => {
    vi.doMock('../../../src/commands/healthCommand', () => mockHealth([], 'ok'));

    const repo = new LogRepository(':memory:');
    for (let i = 0; i < 6; i += 1) {
      repo.insertLog('error', 'SYS', `error-${i}`, { idx: i }, 'system');
    }
    globalThis.__logRepository = repo;

    const { runDoctorCommand } = await import('../../../src/commands/doctorCommand');
    const report = await runDoctorCommand();

    expect(report.findings.some((finding) => finding.id === 'error_spike')).toBe(true);
    expect(report.status).toBe('degraded');
    repo.close();
    globalThis.__logRepository = undefined;
  });

  it('creates error trend anomaly finding when current window spikes against previous window', async () => {
    vi.doMock('../../../src/commands/healthCommand', () => mockHealth([], 'ok'));

    const base = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(base);

    const repo = new LogRepository(':memory:');
    globalThis.__logRepository = repo;

    const previousWindowTs = new Date(base - 20 * 60 * 1000).toISOString();
    const currentWindowTs = new Date(base - 5 * 60 * 1000).toISOString();

    for (let i = 0; i < 2; i += 1) {
      repo.insertLog('error', 'SYS', `old-error-${i}`, { createdAt: previousWindowTs }, 'system');
    }
    for (let i = 0; i < 8; i += 1) {
      repo.insertLog('error', 'SYS', `new-error-${i}`, { createdAt: currentWindowTs }, 'system');
    }

    const originalList = repo.listLogs.bind(repo);
    vi.spyOn(repo, 'listLogs').mockImplementation((filter) => {
      const rows = originalList(filter);
      return rows.map((row) => {
        if (row.message.startsWith('old-error-')) {
          return { ...row, createdAt: previousWindowTs, timestamp: previousWindowTs };
        }
        if (row.message.startsWith('new-error-')) {
          return { ...row, createdAt: currentWindowTs, timestamp: currentWindowTs };
        }
        return row;
      });
    });

    const { runDoctorCommand } = await import('../../../src/commands/doctorCommand');
    const report = await runDoctorCommand();

    expect(report.findings.some((finding) => finding.id === 'error_trend_anomaly')).toBe(true);
    expect(report.recommendations.length).toBeGreaterThan(0);

    repo.close();
    globalThis.__logRepository = undefined;
  });
});
