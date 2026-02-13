import { describe, it, expect } from 'vitest';
import {
  canTransition,
  isActiveStatus,
  KANBAN_COLUMNS,
} from '../../../src/server/worker/workerStateMachine';

describe('WorkerStateMachine', () => {
  describe('isActiveStatus', () => {
    it('returns true for agent-controlled statuses', () => {
      expect(isActiveStatus('planning')).toBe(true);
      expect(isActiveStatus('executing')).toBe(true);
      expect(isActiveStatus('clarifying')).toBe(true);
      expect(isActiveStatus('waiting_approval')).toBe(true);
    });

    it('returns false for non-active statuses', () => {
      expect(isActiveStatus('inbox')).toBe(false);
      expect(isActiveStatus('queued')).toBe(false);
      expect(isActiveStatus('assigned')).toBe(false);
      expect(isActiveStatus('testing')).toBe(false);
      expect(isActiveStatus('review')).toBe(false);
      expect(isActiveStatus('completed')).toBe(false);
      expect(isActiveStatus('failed')).toBe(false);
      expect(isActiveStatus('cancelled')).toBe(false);
      expect(isActiveStatus('interrupted')).toBe(false);
    });
  });

  describe('canTransition (manual)', () => {
    it('allows inbox → queued', () => {
      expect(canTransition('inbox', 'queued', 'manual')).toBe(true);
    });

    it('allows inbox → assigned', () => {
      expect(canTransition('inbox', 'assigned', 'manual')).toBe(true);
    });

    it('allows inbox → cancelled', () => {
      expect(canTransition('inbox', 'cancelled', 'manual')).toBe(true);
    });

    it('blocks inbox → executing', () => {
      expect(canTransition('inbox', 'executing', 'manual')).toBe(false);
    });

    it('allows assigned → queued', () => {
      expect(canTransition('assigned', 'queued', 'manual')).toBe(true);
    });

    it('allows assigned → inbox', () => {
      expect(canTransition('assigned', 'inbox', 'manual')).toBe(true);
    });

    it('blocks active status transitions except → cancelled', () => {
      expect(canTransition('executing', 'review', 'manual')).toBe(false);
      expect(canTransition('executing', 'cancelled', 'manual')).toBe(true);
      expect(canTransition('planning', 'queued', 'manual')).toBe(false);
      expect(canTransition('planning', 'cancelled', 'manual')).toBe(true);
      expect(canTransition('clarifying', 'cancelled', 'manual')).toBe(true);
      expect(canTransition('waiting_approval', 'cancelled', 'manual')).toBe(true);
    });

    it('allows testing → review', () => {
      expect(canTransition('testing', 'review', 'manual')).toBe(true);
    });

    it('allows testing → assigned (send back)', () => {
      expect(canTransition('testing', 'assigned', 'manual')).toBe(true);
    });

    it('allows review → completed', () => {
      expect(canTransition('review', 'completed', 'manual')).toBe(true);
    });

    it('allows review → assigned (send back)', () => {
      expect(canTransition('review', 'assigned', 'manual')).toBe(true);
    });

    it('allows completed → review (reopen)', () => {
      expect(canTransition('completed', 'review', 'manual')).toBe(true);
    });

    it('allows failed → queued (retry)', () => {
      expect(canTransition('failed', 'queued', 'manual')).toBe(true);
    });

    it('allows interrupted → queued (resume)', () => {
      expect(canTransition('interrupted', 'queued', 'manual')).toBe(true);
    });

    it('blocks invalid target', () => {
      expect(canTransition('completed', 'executing', 'manual')).toBe(false);
    });

    it('blocks same-status transition', () => {
      expect(canTransition('inbox', 'inbox', 'manual')).toBe(false);
    });

    it('blocks transitions from cancelled', () => {
      expect(canTransition('cancelled', 'queued', 'manual')).toBe(false);
    });
  });

  describe('canTransition (system)', () => {
    it('allows queued → planning', () => {
      expect(canTransition('queued', 'planning', 'system')).toBe(true);
    });

    it('allows planning → executing', () => {
      expect(canTransition('planning', 'executing', 'system')).toBe(true);
    });

    it('allows executing → testing', () => {
      expect(canTransition('executing', 'testing', 'system')).toBe(true);
    });

    it('allows executing → review (skip testing)', () => {
      expect(canTransition('executing', 'review', 'system')).toBe(true);
    });

    it('allows any → failed (system)', () => {
      expect(canTransition('executing', 'failed', 'system')).toBe(true);
      expect(canTransition('planning', 'failed', 'system')).toBe(true);
      expect(canTransition('testing', 'failed', 'system')).toBe(true);
    });

    it('allows any → cancelled (system)', () => {
      expect(canTransition('executing', 'cancelled', 'system')).toBe(true);
    });

    it('allows any → interrupted (system)', () => {
      expect(canTransition('executing', 'interrupted', 'system')).toBe(true);
    });
  });

  describe('KANBAN_COLUMNS', () => {
    it('has 7 columns', () => {
      expect(KANBAN_COLUMNS).toHaveLength(7);
    });

    it('covers all statuses', () => {
      const allStatuses = KANBAN_COLUMNS.flatMap((col) => col.statuses);
      expect(allStatuses).toContain('inbox');
      expect(allStatuses).toContain('queued');
      expect(allStatuses).toContain('assigned');
      expect(allStatuses).toContain('planning');
      expect(allStatuses).toContain('executing');
      expect(allStatuses).toContain('testing');
      expect(allStatuses).toContain('review');
      expect(allStatuses).toContain('completed');
      expect(allStatuses).toContain('failed');
      expect(allStatuses).toContain('cancelled');
      expect(allStatuses).toContain('interrupted');
    });
  });
});
