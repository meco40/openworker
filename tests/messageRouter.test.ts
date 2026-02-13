import { describe, it, expect } from 'vitest';
import { routeMessage } from '../src/server/channels/messages/messageRouter';

describe('routeMessage', () => {
  // ─── Worker Task Prefixes ─────────────────────────────────
  describe('worker task routing', () => {
    it('routes @worker prefix to worker', () => {
      const result = routeMessage('@worker Erstelle eine App');
      expect(result).toEqual({ target: 'worker', payload: 'Erstelle eine App' });
    });

    it('routes /worker prefix to worker', () => {
      const result = routeMessage('/worker Analysiere PDFs');
      expect(result).toEqual({ target: 'worker', payload: 'Analysiere PDFs' });
    });

    it('handles case-insensitive @Worker', () => {
      const result = routeMessage('@WORKER Uppercase test');
      expect(result).toEqual({ target: 'worker', payload: 'Uppercase test' });
    });

    it('handles case-insensitive /Worker', () => {
      const result = routeMessage('/Worker Mixed case');
      expect(result).toEqual({ target: 'worker', payload: 'Mixed case' });
    });

    it('trims whitespace from payload', () => {
      const result = routeMessage('  @worker   trimmed payload  ');
      expect(result).toEqual({ target: 'worker', payload: 'trimmed payload' });
    });

    it('returns empty payload when only prefix given (no space)', () => {
      const result = routeMessage('@worker');
      expect(result).toEqual({ target: 'worker', payload: '' });
    });

    it('returns empty payload when only prefix given (with space)', () => {
      const result = routeMessage('@worker ');
      expect(result).toEqual({ target: 'worker', payload: '' });
    });
  });

  // ─── Worker Commands ──────────────────────────────────────
  describe('worker commands', () => {
    it('routes /worker-status without id', () => {
      const result = routeMessage('/worker-status');
      expect(result).toEqual({ target: 'worker-command', payload: '', command: '/worker-status' });
    });

    it('routes /worker-status with task id', () => {
      const result = routeMessage('/worker-status task-abc123');
      expect(result).toEqual({
        target: 'worker-command',
        payload: 'task-abc123',
        command: '/worker-status',
      });
    });

    it('routes /worker-cancel', () => {
      const result = routeMessage('/worker-cancel task-abc123');
      expect(result).toEqual({
        target: 'worker-command',
        payload: 'task-abc123',
        command: '/worker-cancel',
      });
    });

    it('routes /worker-list', () => {
      const result = routeMessage('/worker-list');
      expect(result).toEqual({ target: 'worker-command', payload: '', command: '/worker-list' });
    });

    it('routes /worker-retry', () => {
      const result = routeMessage('/worker-retry task-xyz');
      expect(result).toEqual({
        target: 'worker-command',
        payload: 'task-xyz',
        command: '/worker-retry',
      });
    });

    it('routes /worker-resume', () => {
      const result = routeMessage('/worker-resume task-xyz');
      expect(result).toEqual({
        target: 'worker-command',
        payload: 'task-xyz',
        command: '/worker-resume',
      });
    });

    it('routes /approve', () => {
      const result = routeMessage('/approve task-abc');
      expect(result).toEqual({
        target: 'worker-command',
        payload: 'task-abc',
        command: '/approve',
      });
    });

    it('routes /deny', () => {
      const result = routeMessage('/deny task-abc');
      expect(result).toEqual({ target: 'worker-command', payload: 'task-abc', command: '/deny' });
    });

    it('routes /approve-always', () => {
      const result = routeMessage('/approve-always task-abc');
      expect(result).toEqual({
        target: 'worker-command',
        payload: 'task-abc',
        command: '/approve-always',
      });
    });
  });

  // ─── Chat Fallback ────────────────────────────────────────
  describe('chat fallback', () => {
    it('routes normal messages to chat', () => {
      const result = routeMessage('Wie geht es dir?');
      expect(result).toEqual({ target: 'chat', payload: 'Wie geht es dir?' });
    });

    it('does not match @workerXYZ without space', () => {
      const result = routeMessage('@workerXYZ');
      expect(result).toEqual({ target: 'chat', payload: '@workerXYZ' });
    });

    it('does not match partial prefix /work', () => {
      const result = routeMessage('/work something');
      expect(result).toEqual({ target: 'chat', payload: '/work something' });
    });

    it('handles empty string', () => {
      const result = routeMessage('');
      expect(result).toEqual({ target: 'chat', payload: '' });
    });

    it('handles whitespace-only input', () => {
      const result = routeMessage('   ');
      expect(result).toEqual({ target: 'chat', payload: '' });
    });
  });
});
