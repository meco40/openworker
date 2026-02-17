import { describe, it, expect } from 'vitest';
import {
  transitionLifecycle,
  isActiveStatus,
  type LifecycleSignal,
} from '../../../src/server/knowledge/factLifecycle';

describe('transitionLifecycle', () => {
  it('new → confirmed on user_confirmed', () => {
    expect(transitionLifecycle('new', 'user_confirmed')).toBe('confirmed');
  });

  it('new → confirmed on repeated_in_session', () => {
    expect(transitionLifecycle('new', 'repeated_in_session')).toBe('confirmed');
  });

  it('confirmed stays confirmed on repeated_in_session', () => {
    expect(transitionLifecycle('confirmed', 'repeated_in_session')).toBe('confirmed');
  });

  it('confirmed → superseded on contradicted', () => {
    expect(transitionLifecycle('confirmed', 'contradicted')).toBe('superseded');
  });

  it('new → superseded on corrected_by_user', () => {
    expect(transitionLifecycle('new', 'corrected_by_user')).toBe('superseded');
  });

  it('confirmed → stale on time_expired', () => {
    expect(transitionLifecycle('confirmed', 'time_expired')).toBe('stale');
  });

  it('stale → confirmed on reactivated', () => {
    expect(transitionLifecycle('stale', 'reactivated')).toBe('confirmed');
  });

  it('confirmed → rejected on garbage_collected', () => {
    expect(transitionLifecycle('confirmed', 'garbage_collected')).toBe('rejected');
  });

  it('returns current status for unknown signal', () => {
    expect(transitionLifecycle('confirmed', 'unknown_signal' as LifecycleSignal)).toBe('confirmed');
  });
});

describe('isActiveStatus', () => {
  it('new is active', () => {
    expect(isActiveStatus('new')).toBe(true);
  });

  it('confirmed is active', () => {
    expect(isActiveStatus('confirmed')).toBe(true);
  });

  it('stale is not active', () => {
    expect(isActiveStatus('stale')).toBe(false);
  });

  it('superseded is not active', () => {
    expect(isActiveStatus('superseded')).toBe(false);
  });

  it('rejected is not active', () => {
    expect(isActiveStatus('rejected')).toBe(false);
  });
});
