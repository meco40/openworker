import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerEventBus } from '@/server/events/eventBus';

describe('InMemoryServerEventBus', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('publish', () => {
    it('does nothing when no subscribers exist for the event', () => {
      const bus = createServerEventBus();
      expect(() =>
        bus.publish('master.updated', {
          userId: 'u1',
          workspaceId: 'w1',
          resources: ['runs'],
          at: new Date().toISOString(),
        }),
      ).not.toThrow();
    });

    it('does nothing when subscriber set is empty after unsubscribe', () => {
      const bus = createServerEventBus();
      const handler = vi.fn();
      const unsub = bus.subscribe('master.updated', handler);
      unsub(); // Remove only subscriber — set becomes empty
      bus.publish('master.updated', {
        userId: 'u1',
        workspaceId: 'w1',
        resources: ['runs'],
        at: new Date().toISOString(),
      });
      expect(handler).not.toHaveBeenCalled();
    });

    it('calls all subscribers when event is published', () => {
      const bus = createServerEventBus();
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      bus.subscribe('master.updated', handler1);
      bus.subscribe('master.updated', handler2);

      const payload = {
        userId: 'u1',
        workspaceId: 'w1',
        resources: ['runs' as const],
        at: new Date().toISOString(),
      };
      bus.publish('master.updated', payload);

      expect(handler1).toHaveBeenCalledWith(payload);
      expect(handler2).toHaveBeenCalledWith(payload);
    });

    it('logs error but continues calling remaining listeners when one throws', () => {
      const bus = createServerEventBus();
      const throwingHandler = vi.fn(() => {
        throw new Error('handler boom');
      });
      const goodHandler = vi.fn();

      bus.subscribe('master.updated', throwingHandler);
      bus.subscribe('master.updated', goodHandler);

      const payload = {
        userId: 'u1',
        workspaceId: 'w1',
        resources: ['runs' as const],
        at: new Date().toISOString(),
      };

      expect(() => bus.publish('master.updated', payload)).not.toThrow();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"master.updated"'),
        expect.any(Error),
      );
      expect(goodHandler).toHaveBeenCalledWith(payload);
    });
  });

  describe('subscribe / unsubscribe', () => {
    it('returns an unsubscribe function that stops future deliveries', () => {
      const bus = createServerEventBus();
      const handler = vi.fn();
      const unsub = bus.subscribe('master.updated', handler);

      bus.publish('master.updated', {
        userId: 'u1',
        workspaceId: 'w1',
        resources: ['runs'],
        at: new Date().toISOString(),
      });
      expect(handler).toHaveBeenCalledTimes(1);

      unsub();
      bus.publish('master.updated', {
        userId: 'u1',
        workspaceId: 'w1',
        resources: ['runs'],
        at: new Date().toISOString(),
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('calling unsubscribe when no Map entry exists does not throw', () => {
      const bus = createServerEventBus();
      const handler = vi.fn();
      const unsub = bus.subscribe('master.updated', handler);
      // Force-clear all subscribers so the Map entry is gone
      bus.clearAllSubscribers();
      // Now calling the stored unsub function should be safe
      expect(() => unsub()).not.toThrow();
    });

    it('deletes the event key from the Map when the last subscriber unsubscribes', () => {
      const bus = createServerEventBus();
      const handler = vi.fn();
      const unsub = bus.subscribe('master.updated', handler);
      unsub();

      // After removing last subscriber, publishing should still be a no-op (not throw)
      expect(() =>
        bus.publish('master.updated', {
          userId: 'u1',
          workspaceId: 'w1',
          resources: ['runs'],
          at: new Date().toISOString(),
        }),
      ).not.toThrow();
      expect(handler).not.toHaveBeenCalled();
    });

    it('handles multiple event types independently', () => {
      const bus = createServerEventBus();
      const masterHandler = vi.fn();
      const summaryHandler = vi.fn();

      bus.subscribe('master.updated', masterHandler);
      bus.subscribe('chat.summary.refreshed', summaryHandler);

      bus.publish('master.updated', {
        userId: 'u1',
        workspaceId: 'w1',
        resources: ['runs'],
        at: new Date().toISOString(),
      });

      expect(masterHandler).toHaveBeenCalledTimes(1);
      expect(summaryHandler).not.toHaveBeenCalled();
    });
  });

  describe('clearAllSubscribers', () => {
    it('removes all subscribers for all events', () => {
      const bus = createServerEventBus();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      bus.subscribe('master.updated', handler1);
      bus.subscribe('chat.summary.refreshed', handler2);

      bus.clearAllSubscribers();

      bus.publish('master.updated', {
        userId: 'u1',
        workspaceId: 'w1',
        resources: ['runs'],
        at: new Date().toISOString(),
      });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('is safe to call when no subscribers exist', () => {
      const bus = createServerEventBus();
      expect(() => bus.clearAllSubscribers()).not.toThrow();
    });
  });
});
