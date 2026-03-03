import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getProactiveRepository, getProactiveGateService } from '@/server/proactive/runtime';
import { ProactiveGateService } from '@/server/proactive/service';
import { SqliteProactiveRepository } from '@/server/proactive/sqliteProactiveRepository';

describe('proactive/runtime', () => {
  beforeEach(() => {
    globalThis.__proactiveRepository = undefined;
    globalThis.__proactiveGateService = undefined;
  });

  afterEach(() => {
    globalThis.__proactiveRepository = undefined;
    globalThis.__proactiveGateService = undefined;
  });

  describe('getProactiveRepository', () => {
    it('creates a new SqliteProactiveRepository instance on first call', () => {
      const repo = getProactiveRepository();
      expect(repo).toBeInstanceOf(SqliteProactiveRepository);
    });

    it('returns the same instance on subsequent calls (singleton pattern)', () => {
      const repo1 = getProactiveRepository();
      const repo2 = getProactiveRepository();
      expect(repo1).toBe(repo2);
    });

    it('uses existing global instance if available', () => {
      const customRepo = new SqliteProactiveRepository();
      globalThis.__proactiveRepository = customRepo;

      const repo = getProactiveRepository();
      expect(repo).toBe(customRepo);
    });
  });

  describe('getProactiveGateService', () => {
    it('creates a new ProactiveGateService instance on first call', () => {
      const service = getProactiveGateService();
      expect(service).toBeInstanceOf(ProactiveGateService);
    });

    it('returns the same instance on subsequent calls (singleton pattern)', () => {
      const service1 = getProactiveGateService();
      const service2 = getProactiveGateService();
      expect(service1).toBe(service2);
    });

    it('uses existing global instance if available', () => {
      const repo = new SqliteProactiveRepository();
      const customService = new ProactiveGateService(repo);
      globalThis.__proactiveGateService = customService;

      const service = getProactiveGateService();
      expect(service).toBe(customService);
    });

    it('creates service with repository from getProactiveRepository', () => {
      globalThis.__proactiveGateService = undefined;
      const repo = getProactiveRepository();
      const service = getProactiveGateService();

      expect(service).toBeInstanceOf(ProactiveGateService);
      expect(getProactiveRepository()).toBe(repo);
    });
  });

  describe('integration', () => {
    it('maintains separate singleton instances for repo and service', () => {
      const repo = getProactiveRepository();
      const service = getProactiveGateService();

      expect(repo).toBeInstanceOf(SqliteProactiveRepository);
      expect(service).toBeInstanceOf(ProactiveGateService);
      expect(repo).not.toBe(service);
    });

    it('preserves instances across multiple calls to both functions', () => {
      const repo1 = getProactiveRepository();
      const service1 = getProactiveGateService();
      const repo2 = getProactiveRepository();
      const service2 = getProactiveGateService();

      expect(repo1).toBe(repo2);
      expect(service1).toBe(service2);
    });
  });
});
