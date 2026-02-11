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
  delete process.env.WORKER_DB_PATH;
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

  it('creates backlog finding when more than 20 tasks are open', async () => {
    vi.doMock('../../../src/commands/healthCommand', () => mockHealth([], 'ok'));
    process.env.WORKER_DB_PATH = ':memory:';

    const { getWorkerRepository } = await import('../../../src/server/worker/workerRepository');
    const repo = getWorkerRepository();
    for (let i = 0; i < 21; i += 1) {
      repo.createTask({
        title: `Task ${i}`,
        objective: 'Backlog growth',
        originPlatform: 'WebChat' as never,
        originConversation: `conv-${i}`,
      });
    }

    const { runDoctorCommand } = await import('../../../src/commands/doctorCommand');
    const report = await runDoctorCommand();

    expect(report.findings.some((finding) => finding.id === 'task_backlog')).toBe(true);
    expect(report.status).toBe('degraded');
  });
});
