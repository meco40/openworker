import { intervalToCronExpression } from './cronEngine';

type ParsedCronCommand =
  | {
      action: 'add';
      cronExpression: string;
      timezone: string;
      prompt: string;
      name: string | null;
    }
  | {
      action: 'every';
      cronExpression: string;
      timezone: string;
      prompt: string;
      name: string | null;
      interval: string;
    }
  | { action: 'list' }
  | { action: 'pause'; ruleId: string }
  | { action: 'resume'; ruleId: string }
  | { action: 'remove'; ruleId: string }
  | { action: 'run'; ruleId: string }
  | { action: 'unsupported'; reason: string };

function extractQuotedValue(input: string, flag: string): string | null {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = input.match(new RegExp(`${escaped}\\s+"([^"]+)"`, 'i'));
  return match?.[1] || null;
}

function extractRuleId(input: string, action: string): string | null {
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = input.match(new RegExp(`^/cron\\s+${escaped}\\s+([^\\s]+)$`, 'i'));
  return match?.[1] || null;
}

export function parseCronCommand(content: string): ParsedCronCommand {
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();

  if (!lower.startsWith('/cron')) {
    return { action: 'unsupported', reason: 'Not a /cron command' };
  }

  if (lower === '/cron list') {
    return { action: 'list' };
  }

  if (lower.startsWith('/cron add ')) {
    const expressionMatch = trimmed.match(/^\/cron\s+add\s+"([^"]+)"/i);
    const cronExpression = expressionMatch?.[1] || '';
    const timezone = extractQuotedValue(trimmed, '--tz') || 'UTC';
    const prompt = extractQuotedValue(trimmed, '--prompt');
    const name = extractQuotedValue(trimmed, '--name');

    if (!cronExpression || !prompt) {
      return { action: 'unsupported', reason: 'Missing cron expression or prompt for /cron add' };
    }

    return {
      action: 'add',
      cronExpression,
      timezone,
      prompt,
      name,
    };
  }

  if (lower.startsWith('/cron every ')) {
    const intervalMatch = trimmed.match(/^\/cron\s+every\s+"([^"]+)"/i);
    const interval = intervalMatch?.[1] || '';
    const cronExpression = intervalToCronExpression(interval);
    const timezone = extractQuotedValue(trimmed, '--tz') || 'UTC';
    const prompt = extractQuotedValue(trimmed, '--prompt');
    const name = extractQuotedValue(trimmed, '--name');

    if (!interval || !cronExpression || !prompt) {
      return { action: 'unsupported', reason: 'Invalid interval or prompt for /cron every' };
    }

    return {
      action: 'every',
      interval,
      cronExpression,
      timezone,
      prompt,
      name,
    };
  }

  const pauseId = extractRuleId(trimmed, 'pause');
  if (pauseId) {
    return { action: 'pause', ruleId: pauseId };
  }

  const resumeId = extractRuleId(trimmed, 'resume');
  if (resumeId) {
    return { action: 'resume', ruleId: resumeId };
  }

  const removeId = extractRuleId(trimmed, 'remove');
  if (removeId) {
    return { action: 'remove', ruleId: removeId };
  }

  const runId = extractRuleId(trimmed, 'run');
  if (runId) {
    return { action: 'run', ruleId: runId };
  }

  return { action: 'unsupported', reason: 'Unknown /cron subcommand' };
}
