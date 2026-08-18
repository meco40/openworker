interface PolicyContext {
  now: string;
  quietHours?: { start: number; end: number };
  dailyBudget?: number;
  deliveredToday?: number;
  channelAvailable?: boolean;
  userInteractionActive?: boolean;
}

export interface DeliveryDecision {
  allow: boolean;
  reason: 'allow' | 'quiet_time' | 'budget_exceeded' | 'channel_unavailable' | 'user_active';
}

export function decideOpenLoopDelivery(
  loop: {
    importance?: number;
    attempts?: number;
    maxAttempts?: number;
    doNotAskBefore?: string;
    triggerAt?: string;
    status: string;
  },
  ctx: PolicyContext,
): DeliveryDecision {
  const attempts = loop.attempts ?? 0;
  const maxAttempts = loop.maxAttempts ?? 3;
  if (attempts >= maxAttempts) {
    return { allow: false, reason: 'budget_exceeded' };
  }
  if (loop.status !== 'open' && loop.status !== 'scheduled') {
    return { allow: false, reason: 'user_active' };
  }
  if (
    loop.doNotAskBefore &&
    new Date(loop.doNotAskBefore).getTime() > new Date(ctx.now).getTime()
  ) {
    return { allow: false, reason: 'quiet_time' };
  }
  if (ctx.userInteractionActive) {
    return { allow: false, reason: 'user_active' };
  }
  if (ctx.quietHours) {
    const hour = new Date(ctx.now).getUTCHours();
    if (isInQuietWindow(hour, ctx.quietHours.start, ctx.quietHours.end)) {
      return { allow: false, reason: 'quiet_time' };
    }
  }
  if (ctx.dailyBudget !== undefined && (ctx.deliveredToday ?? 0) >= ctx.dailyBudget) {
    return { allow: false, reason: 'budget_exceeded' };
  }
  if (ctx.channelAvailable === false) {
    return { allow: false, reason: 'channel_unavailable' };
  }
  return { allow: true, reason: 'allow' };
}

function isInQuietWindow(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}
