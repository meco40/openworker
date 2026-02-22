import { describe, expect, it } from 'vitest';

import { parseCronCommand } from '@/server/automation/commands';

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

  it('parses /cron every command with interval, name and defaults', () => {
    const parsed = parseCronCommand(
      '/cron every "15m" --prompt "Ship report" --name "Team digest"',
    );

    expect(parsed).toEqual({
      action: 'every',
      interval: '15m',
      cronExpression: '*/15 * * * *',
      timezone: 'UTC',
      prompt: 'Ship report',
      name: 'Team digest',
    });
  });

  it('parses list/resume/remove/run commands', () => {
    expect(parseCronCommand('/cron list')).toEqual({ action: 'list' });
    expect(parseCronCommand('/cron resume rule-123')).toEqual({
      action: 'resume',
      ruleId: 'rule-123',
    });
    expect(parseCronCommand('/cron remove rule-456')).toEqual({
      action: 'remove',
      ruleId: 'rule-456',
    });
    expect(parseCronCommand('/cron run rule-789')).toEqual({
      action: 'run',
      ruleId: 'rule-789',
    });
  });

  it('parses /cron pause command', () => {
    const parsed = parseCronCommand('/cron pause rule-123');
    expect(parsed).toEqual({ action: 'pause', ruleId: 'rule-123' });
  });

  it('returns unsupported for invalid add/every payloads', () => {
    expect(parseCronCommand('/cron add "0 10 * * *" --tz "UTC"')).toEqual({
      action: 'unsupported',
      reason: 'Missing cron expression or prompt for /cron add',
    });
    expect(parseCronCommand('/cron add "0 10 * * *" --prompt no-quotes')).toEqual({
      action: 'unsupported',
      reason: 'Missing cron expression or prompt for /cron add',
    });
    expect(parseCronCommand('/cron every "999m" --prompt "nope"')).toEqual({
      action: 'unsupported',
      reason: 'Invalid interval or prompt for /cron every',
    });
  });

  it('returns unsupported for unknown command shapes', () => {
    expect(parseCronCommand('/notcron hello')).toEqual({
      action: 'unsupported',
      reason: 'Not a /cron command',
    });
    expect(parseCronCommand('/cron pause')).toEqual({
      action: 'unsupported',
      reason: 'Unknown /cron subcommand',
    });
    expect(parseCronCommand('/cron pause rule-123 extra')).toEqual({
      action: 'unsupported',
      reason: 'Unknown /cron subcommand',
    });
    expect(parseCronCommand('/cron hello')).toEqual({
      action: 'unsupported',
      reason: 'Unknown /cron subcommand',
    });
  });
});
