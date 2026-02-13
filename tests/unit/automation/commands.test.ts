import { describe, expect, it } from 'vitest';

import { parseCronCommand } from '../../../src/server/automation/commands';

describe('automation command parser', () => {
  it('parses /cron add command with quoted args', () => {
    const parsed = parseCronCommand(
      '/cron add "0 10 * * *" --tz "Europe/Berlin" --prompt "Give me a briefing"',
    );

    expect(parsed).toEqual({
      action: 'add',
      cronExpression: '0 10 * * *',
      timezone: 'Europe/Berlin',
      prompt: 'Give me a briefing',
      name: null,
    });
  });

  it('parses /cron pause command', () => {
    const parsed = parseCronCommand('/cron pause rule-123');
    expect(parsed).toEqual({ action: 'pause', ruleId: 'rule-123' });
  });

  it('returns unsupported for unknown command shapes', () => {
    const parsed = parseCronCommand('/cron hello');
    expect(parsed).toEqual({ action: 'unsupported', reason: 'Unknown /cron subcommand' });
  });
});
