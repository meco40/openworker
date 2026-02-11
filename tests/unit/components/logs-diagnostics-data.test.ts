import { describe, expect, it } from 'vitest';

import {
  extractDoctorFindingDetails,
  extractHealthIssues,
} from '../../../components/LogsView';

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
});
