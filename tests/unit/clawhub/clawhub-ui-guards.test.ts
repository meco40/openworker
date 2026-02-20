import { describe, expect, it, vi } from 'vitest';

import {
  CLAWHUB_CHANGED_EVENT,
  emitClawHubChanged,
  subscribeClawHubChanged,
  type ClawHubEventTarget,
} from '@/skills/clawhub-events';

describe('ClawHub UI guardrails', () => {
  it('emits clawhub changed event on provided target', () => {
    const target = new EventTarget();
    const listener = vi.fn();
    target.addEventListener(CLAWHUB_CHANGED_EVENT, listener);

    emitClawHubChanged(target as unknown as ClawHubEventTarget);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('subscribes and unsubscribes clawhub changed listener', () => {
    const target = new EventTarget();
    const listener = vi.fn();

    const unsubscribe = subscribeClawHubChanged(target as unknown as ClawHubEventTarget, listener);

    target.dispatchEvent(new Event(CLAWHUB_CHANGED_EVENT));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    target.dispatchEvent(new Event(CLAWHUB_CHANGED_EVENT));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('returns no-op unsubscribe when target is missing', () => {
    const unsubscribe = subscribeClawHubChanged(null, () => {
      // no-op listener
    });
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });
});
