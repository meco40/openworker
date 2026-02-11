import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LogRepository } from '../../../src/logging/logRepository';

describe('LogRepository', () => {
  let repo: LogRepository;

  beforeEach(() => {
    repo = new LogRepository(':memory:');
  });

  afterEach(() => {
    repo.close();
  });

  describe('insertLog', () => {
    it('inserts and returns a log entry', () => {
      const entry = repo.insertLog('info', 'SYS', 'Gateway started on port 8080');
      expect(entry.id).toMatch(/^log-/);
      expect(entry.level).toBe('info');
      expect(entry.source).toBe('SYS');
      expect(entry.message).toBe('Gateway started on port 8080');
      expect(entry.metadata).toBeNull();
      expect(entry.timestamp).toBeTruthy();
      expect(entry.createdAt).toBeTruthy();
    });

    it('stores metadata as JSON', () => {
      const entry = repo.insertLog('error', 'AUTH', 'Token expired', {
        userId: 'u1',
        retries: 3,
      });
      expect(entry.metadata).toEqual({ userId: 'u1', retries: 3 });
    });
  });

  describe('listLogs', () => {
    beforeEach(() => {
      repo.insertLog('info', 'SYS', 'System started');
      repo.insertLog('warn', 'BRIDGE', 'Latency spike detected');
      repo.insertLog('error', 'AUTH', 'Failed to validate token');
      repo.insertLog('info', 'TOOL', 'Image generated successfully');
      repo.insertLog('debug', 'SYS', 'Heartbeat check');
    });

    it('returns all logs in chronological order', () => {
      const logs = repo.listLogs();
      expect(logs).toHaveLength(5);
      expect(logs[0].message).toBe('System started');
      expect(logs[4].message).toBe('Heartbeat check');
    });

    it('filters by level', () => {
      const logs = repo.listLogs({ level: 'info' });
      expect(logs).toHaveLength(2);
      expect(logs.every((l) => l.level === 'info')).toBe(true);
    });

    it('filters by source', () => {
      const logs = repo.listLogs({ source: 'SYS' });
      expect(logs).toHaveLength(2);
      expect(logs.every((l) => l.source === 'SYS')).toBe(true);
    });

    it('filters by search term', () => {
      const logs = repo.listLogs({ search: 'token' });
      expect(logs).toHaveLength(1);
      expect(logs[0].source).toBe('AUTH');
    });

    it('respects limit', () => {
      const logs = repo.listLogs({ limit: 2 });
      expect(logs).toHaveLength(2);
    });

    it('supports combined filters', () => {
      const logs = repo.listLogs({ level: 'info', source: 'SYS' });
      expect(logs).toHaveLength(1);
      expect(logs[0].message).toBe('System started');
    });
  });

  describe('getLogCount', () => {
    it('returns total count', () => {
      repo.insertLog('info', 'SYS', 'A');
      repo.insertLog('error', 'AUTH', 'B');
      repo.insertLog('info', 'SYS', 'C');
      expect(repo.getLogCount()).toBe(3);
    });

    it('returns count by level', () => {
      repo.insertLog('info', 'SYS', 'A');
      repo.insertLog('error', 'AUTH', 'B');
      repo.insertLog('info', 'SYS', 'C');
      expect(repo.getLogCount('info')).toBe(2);
      expect(repo.getLogCount('error')).toBe(1);
      expect(repo.getLogCount('warn')).toBe(0);
    });
  });

  describe('getSources', () => {
    it('returns distinct sources sorted', () => {
      repo.insertLog('info', 'SYS', 'A');
      repo.insertLog('info', 'AUTH', 'B');
      repo.insertLog('info', 'SYS', 'C');
      repo.insertLog('info', 'TOOL', 'D');
      expect(repo.getSources()).toEqual(['AUTH', 'SYS', 'TOOL']);
    });
  });

  describe('clearLogs', () => {
    it('deletes all logs and returns count', () => {
      repo.insertLog('info', 'SYS', 'A');
      repo.insertLog('info', 'SYS', 'B');
      const deleted = repo.clearLogs();
      expect(deleted).toBe(2);
      expect(repo.listLogs()).toHaveLength(0);
      expect(repo.getLogCount()).toBe(0);
    });
  });

  describe('pagination', () => {
    it('supports cursor-based pagination via before', () => {
      const first = repo.insertLog('info', 'SYS', 'First');
      // Small delay to ensure different timestamps
      repo.insertLog('info', 'SYS', 'Second');
      repo.insertLog('info', 'SYS', 'Third');

      const logs = repo.listLogs({ before: first.createdAt });
      // Should get no entries before the first one
      expect(logs).toHaveLength(0);
    });
  });
});
