import { CronExpressionParser } from 'cron-parser';

export function validateTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function validateCronExpression(expression: string, timezone = 'UTC'): boolean {
  try {
    if (!validateTimezone(timezone)) {
      return false;
    }
    CronExpressionParser.parse(expression, { tz: timezone });
    return true;
  } catch {
    return false;
  }
}

export function computeNextRunAt(expression: string, timezone: string, fromIso?: string): string {
  if (!validateTimezone(timezone)) {
    throw new Error(`Invalid timezone: ${timezone}`);
  }

  const currentDate = fromIso ? new Date(fromIso) : new Date();
  const parsed = CronExpressionParser.parse(expression, {
    currentDate,
    tz: timezone,
  });

  const next = parsed.next().toISOString();
  if (!next) {
    throw new Error('Could not compute next run');
  }
  return next;
}

export function intervalToCronExpression(interval: string): string | null {
  const match = interval.trim().match(/^(\d+)(m|h|d)$/i);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  if (unit === 'm') {
    if (amount > 59) return null;
    return `*/${amount} * * * *`;
  }

  if (unit === 'h') {
    if (amount > 23) return null;
    return `0 */${amount} * * *`;
  }

  if (unit === 'd') {
    if (amount > 31) return null;
    return `0 0 */${amount} * *`;
  }

  return null;
}
