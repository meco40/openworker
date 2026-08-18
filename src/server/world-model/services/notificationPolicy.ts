export interface NotificationCounts {
  deliveredToday: number;
}

export interface NotificationPolicyConfig {
  quietHours?: { start: number; end: number };
  dailyBudget?: number;
  channelPref?: Record<string, boolean>;
}

export interface NotificationDecision {
  allow: boolean;
  reason: 'allow' | 'quiet_time' | 'budget_exceeded' | 'channel_closed';
}

/**
 * Canal-übergreifende Benachrichtigungspolitik. Proaktive Nachrichten dürfen
 * nur zugestellt werden, wenn sie Ruhezeiten, Tagesbudget und Kanalpräferenz
 * respektieren. Diese Funktion ist bewusst rein (ohne DB), damit Policy und
 * Zustellung getrennt testbar sind.
 */
export function decideNotification(
  ctx: {
    now: string;
    channel: string;
    counts: NotificationCounts;
  },
  config: NotificationPolicyConfig,
): NotificationDecision {
  const hour = new Date(ctx.now).getUTCHours();
  if (config.quietHours && isInQuietWindow(hour, config.quietHours.start, config.quietHours.end)) {
    return { allow: false, reason: 'quiet_time' };
  }

  if (config.dailyBudget !== undefined && ctx.counts.deliveredToday >= config.dailyBudget) {
    return { allow: false, reason: 'budget_exceeded' };
  }

  if (config.channelPref && config.channelPref[ctx.channel] === false) {
    return { allow: false, reason: 'channel_closed' };
  }

  return { allow: true, reason: 'allow' };
}

function isInQuietWindow(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}
