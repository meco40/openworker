import { describe, expect, it } from 'vitest';

import {
  DIAGNOSTICS_REFRESH_INTERVAL_MS,
  extractDoctorFindingDetails,
  extractHealthIssues,
  summarizeHealthChecks,
  toHealthDiagnosticsStatus,
  toHealthIssueInsight,
} from '@/components/LogsView';

describe('LogsView diagnostics data helpers', () => {
  it('extracts warning and critical health issues from checks', () => {
    const issues = extractHealthIssues([
      { id: 'logging.db', status: 'ok', message: 'ok' },
      { id: 'integration.whatsapp_bridge', status: 'warning', message: 'Bridge timeout' },
      { id: 'security.snapshot', status: 'critical', message: 'Missing secret' },
    ]);

    expect(issues).toEqual([
      'integration.whatsapp_bridge: Bridge timeout',
      'security.snapshot: Missing secret',
    ]);
  });

  it('extracts readable doctor finding details', () => {
    const details = extractDoctorFindingDetails([
      {
        severity: 'warning',
        title: 'Bridge Health Degraded',
        detail: 'Bridge timeout while probing health endpoint',
      },
    ]);

    expect(details).toEqual([
      'Bridge Health Degraded: Bridge timeout while probing health endpoint',
    ]);
  });

  it('maps memory pressure issues to clear meaning and action', () => {
    const insight = toHealthIssueInsight(
      'diagnostics.memory_pressure: Memory pressure critical: 98.2% heap usage.',
    );

    expect(insight.code).toBe('diagnostics.memory_pressure');
    expect(insight.severity).toBe('critical');
    expect(insight.meaning).toContain('Arbeitsspeicher');
    expect(insight.action).toContain('Last');
  });

  it('uses generic fallback for unknown issue codes', () => {
    const insight = toHealthIssueInsight('unknown.check: Something unexpected happened');

    expect(insight.code).toBe('unknown.check');
    expect(insight.severity).toBe('warning');
    expect(insight.meaning).toContain('Diagnose-Check');
    expect(insight.action).toContain('/api/health');
  });

  it('summarizes health checks and derives degraded status', () => {
    const summary = summarizeHealthChecks([
      { id: 'a', status: 'ok', message: 'ok' },
      { id: 'b', status: 'warning', message: 'warn' },
      { id: 'c', status: 'skipped', message: 'skip' },
    ]);

    expect(summary).toEqual({ ok: 1, warning: 1, critical: 0, skipped: 1 });
    expect(toHealthDiagnosticsStatus(summary)).toBe('degraded');
  });

  it('uses 180-second diagnostics refresh interval', () => {
    expect(DIAGNOSTICS_REFRESH_INTERVAL_MS).toBe(180000);
  });
});
