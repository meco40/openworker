import { buildSecurityStatusSnapshot } from '../../../server/security/status';
import type { HealthCheck, HealthCheckStatus } from '../../healthTypes';
import { elapsedMs, failCheck } from '../checkHelpers';

export function runSecuritySnapshotCheck(): HealthCheck {
  const start = Date.now();
  try {
    const snapshot = buildSecurityStatusSnapshot();
    const status: HealthCheckStatus =
      snapshot.summary.critical > 0 ? 'critical' : snapshot.summary.warning > 0 ? 'warning' : 'ok';
    return {
      id: 'security.snapshot',
      category: 'security',
      status,
      message:
        status === 'ok'
          ? 'Security snapshot healthy.'
          : status === 'warning'
            ? 'Security snapshot contains warnings.'
            : 'Security snapshot contains critical findings.',
      latencyMs: elapsedMs(start),
      details: {
        summary: snapshot.summary,
        channels: snapshot.channels,
      },
    };
  } catch (error) {
    return failCheck(
      'security.snapshot',
      'security',
      start,
      'critical',
      `Security snapshot failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}
