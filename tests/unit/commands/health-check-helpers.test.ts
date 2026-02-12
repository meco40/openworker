import { describe, expect, it } from 'vitest';

import {
  elapsedMs,
  formatPercent,
  normalizeCommand,
  okCheck,
  failCheck,
  skippedCheck,
} from '../../../src/commands/health/checkHelpers';

describe('health check helpers', () => {
  it('formats percentages with one decimal', () => {
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(0.1234)).toBe('12.3%');
  });

  it('normalizes and truncates command strings', () => {
    const raw = '  npm    run    test   -- --watch   ';
    expect(normalizeCommand(raw)).toBe('npm run test -- --watch');

    const long = `cmd ${'x'.repeat(400)}`;
    const normalized = normalizeCommand(long);
    expect(normalized.length).toBeLessThanOrEqual(240);
    expect(normalized.endsWith('...')).toBe(true);
  });

  it('builds check payloads with expected status fields', () => {
    const start = Date.now() - 20;
    const ok = okCheck('id.ok', 'core', start, 'ok message');
    expect(ok.status).toBe('ok');
    expect(ok.latencyMs).toBeGreaterThanOrEqual(0);

    const fail = failCheck('id.fail', 'diagnostics', start, 'warning', 'fail message');
    expect(fail.status).toBe('warning');

    const skipped = skippedCheck('id.skip', 'integration', 'skip message');
    expect(skipped.status).toBe('skipped');
    expect(skipped.latencyMs).toBe(0);
  });

  it('calculates elapsed milliseconds', () => {
    const start = Date.now() - 5;
    expect(elapsedMs(start)).toBeGreaterThanOrEqual(5);
  });
});
