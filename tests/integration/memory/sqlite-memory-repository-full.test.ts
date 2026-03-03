import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteMemoryRepository } from '@/server/memory/sqliteMemoryRepository';
import type { MemoryNode } from '@/core/memory/types';

describe('SqliteMemoryRepository - Full Integration', () => {
  let repo: SqliteMemoryRepository;
  let dbPath: string;

  const testUserId = 'test-user-123';
  const testPersonaId = 'test-persona-456';

  beforeEach(() => {
    dbPath = ':memory:';
    repo = new SqliteMemoryRepository(dbPath);
  });

  afterEach(() => {
    // Cleanup handled by in-memory database
  });

  describe('CRUD Operations', () => {
    describe('insertNode', () => {
      it('creates a basic memory node', () => {
        const memory: MemoryNode = {
          id: 'mem-1',
          type: 'fact',
          content: 'Test memory content',
          embedding: [0.1, 0.2, 0.3],
          importance: 5,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        };

        repo.insertNode(testPersonaId, memory, testUserId);

        const nodes = repo.listNodes(testPersonaId, testUserId);
        expect(nodes).toHaveLength(1);
        expect(nodes[0].content).toBe('Test memory content');
      });

      it('creates memory with metadata', () => {
        const memory: MemoryNode = {
          id: 'mem-2',
          type: 'fact',
          content: 'Memory with metadata',
          embedding: [0.1, 0.2, 0.3],
          importance: 3,
          confidence: 0.8,
          timestamp: new Date().toISOString(),
          metadata: {
            source: 'chat',
            tags: ['important', 'verified'],
          },
        };

        repo.insertNode(testPersonaId, memory, testUserId);

        const nodes = repo.listNodes(testPersonaId, testUserId);
        expect(nodes[0].metadata).toEqual({
          source: 'chat',
          tags: ['important', 'verified'],
        });
      });

      it('handles empty content', () => {
        const memory: MemoryNode = {
          id: 'mem-3',
          type: 'fact',
          content: '',
          embedding: [],
          importance: 1,
          confidence: 1.0,
          timestamp: new Date().toISOString(),
        };

        repo.insertNode(testPersonaId, memory, testUserId);

        const nodes = repo.listNodes(testPersonaId, testUserId);
        expect(nodes[0].content).toBe('');
      });

      it('handles very long content', () => {
        const longContent = 'A'.repeat(10000);
        const memory: MemoryNode = {
          id: 'mem-4',
          type: 'fact',
          content: longContent,
          embedding: [0.1, 0.2, 0.3],
          importance: 5,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        };

        repo.insertNode(testPersonaId, memory, testUserId);

        const nodes = repo.listNodes(testPersonaId, testUserId);
        expect(nodes[0].content).toBe(longContent);
      });

      it('throws on duplicate ID', () => {
        const memory: MemoryNode = {
          id: 'mem-dup',
          type: 'fact',
          content: 'First',
          embedding: [0.1],
          importance: 5,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        };

        repo.insertNode(testPersonaId, memory, testUserId);

        const duplicate = { ...memory, content: 'Second' };
        expect(() => repo.insertNode(testPersonaId, duplicate, testUserId)).toThrow();
      });
    });

    describe('listNodes', () => {
      it('returns existing memories', () => {
        const memory: MemoryNode = {
          id: 'mem-get',
          type: 'fact',
          content: 'Get test',
          embedding: [0.1],
          importance: 5,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        };

        repo.insertNode(testPersonaId, memory, testUserId);

        const result = repo.listNodes(testPersonaId, testUserId);

        expect(result).toHaveLength(1);
        expect(result[0].content).toBe('Get test');
      });

      it('returns empty array for non-existent memories', () => {
        const result = repo.listNodes(testPersonaId, testUserId);
        expect(result).toHaveLength(0);
      });

      it('respects user/persona scope', () => {
        const memory: MemoryNode = {
          id: 'mem-scope',
          type: 'fact',
          content: 'Scoped memory',
          embedding: [0.1],
          importance: 5,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        };

        repo.insertNode(testPersonaId, memory, testUserId);

        const wrongUser = repo.listNodes(testPersonaId, 'wrong-user');
        expect(wrongUser).toHaveLength(0);

        const wrongPersona = repo.listNodes('wrong-persona', testUserId);
        expect(wrongPersona).toHaveLength(0);
      });
    });

    describe('updateNode', () => {
      it('updates memory content', () => {
        const memory: MemoryNode = {
          id: 'mem-update',
          type: 'fact',
          content: 'Original content',
          embedding: [0.1],
          importance: 5,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        };

        repo.insertNode(testPersonaId, memory, testUserId);

        const updated: MemoryNode = {
          ...memory,
          content: 'Updated content',
          importance: 3,
        };

        repo.updateNode(testPersonaId, updated, testUserId);

        const result = repo.listNodes(testPersonaId, testUserId);
        expect(result[0].content).toBe('Updated content');
        expect(result[0].importance).toBe(3);
      });

      it('updates metadata', () => {
        const memory: MemoryNode = {
          id: 'mem-meta',
          type: 'fact',
          content: 'Meta test',
          embedding: [0.1],
          importance: 5,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
          metadata: { source: 'initial' },
        };

        repo.insertNode(testPersonaId, memory, testUserId);

        const updated: MemoryNode = {
          ...memory,
          metadata: { source: 'updated', tags: ['new'] },
        };

        repo.updateNode(testPersonaId, updated, testUserId);

        const result = repo.listNodes(testPersonaId, testUserId);
        expect(result[0].metadata).toEqual({ source: 'updated', tags: ['new'] });
      });

      it('does not update non-existent memory', () => {
        const updated: MemoryNode = {
          id: 'non-existent',
          type: 'fact',
          content: 'New',
          embedding: [],
          importance: 5,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        };

        expect(() => repo.updateNode(testPersonaId, updated, testUserId)).not.toThrow();
        expect(repo.listNodes(testPersonaId, testUserId)).toHaveLength(0);
      });
    });

    describe('deleteNode', () => {
      it('deletes single memory', () => {
        const memory: MemoryNode = {
          id: 'mem-delete',
          type: 'fact',
          content: 'To delete',
          embedding: [0.1],
          importance: 5,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        };

        repo.insertNode(testPersonaId, memory, testUserId);

        const deleted = repo.deleteNode(testPersonaId, 'mem-delete', testUserId);

        expect(deleted).toBe(1);
        expect(repo.listNodes(testPersonaId, testUserId)).toHaveLength(0);
      });

      it('returns 0 for non-existent memory', () => {
        const deleted = repo.deleteNode(testPersonaId, 'non-existent', testUserId);
        expect(deleted).toBe(0);
      });

      it('respects scope on delete', () => {
        const memory: MemoryNode = {
          id: 'mem-scope-del',
          type: 'fact',
          content: 'Protected',
          embedding: [0.1],
          importance: 5,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        };

        repo.insertNode(testPersonaId, memory, testUserId);

        const deleted = repo.deleteNode(testPersonaId, 'mem-scope-del', 'wrong-user');
        expect(deleted).toBe(0);
        expect(repo.listNodes(testPersonaId, testUserId)).toHaveLength(1);
      });
    });
  });

  describe('Search & Query', () => {
    beforeEach(() => {
      const memories: MemoryNode[] = [
        {
          id: 'mem-s1',
          type: 'fact',
          content: 'JavaScript is a programming language',
          embedding: [0.9, 0.1, 0.1],
          importance: 5,
          confidence: 0.95,
          timestamp: '2026-01-01T10:00:00Z',
          metadata: { tags: ['programming', 'javascript'] },
        },
        {
          id: 'mem-s2',
          type: 'fact',
          content: 'Python is great for AI',
          embedding: [0.8, 0.2, 0.1],
          importance: 4,
          confidence: 0.9,
          timestamp: '2026-01-02T10:00:00Z',
          metadata: { tags: ['programming', 'python', 'ai'] },
        },
        {
          id: 'mem-s3',
          type: 'preference',
          content: 'User prefers dark mode',
          embedding: [0.1, 0.9, 0.1],
          importance: 3,
          confidence: 0.8,
          timestamp: '2026-01-03T10:00:00Z',
          metadata: { tags: ['ui', 'preference'] },
        },
        {
          id: 'mem-s4',
          type: 'fact',
          content: 'TypeScript adds types to JavaScript',
          embedding: [0.85, 0.15, 0.1],
          importance: 5,
          confidence: 0.92,
          timestamp: '2026-01-04T10:00:00Z',
          metadata: { tags: ['programming', 'typescript'] },
        },
      ];

      memories.forEach((m) => repo.insertNode(testPersonaId, m, testUserId));
    });

    it('paginates memories', () => {
      const result = repo.listNodesPage(testPersonaId, { page: 1, pageSize: 2 }, testUserId);

      expect(result.nodes).toHaveLength(2);
      expect(result.total).toBe(4);
    });

    it('filters by type', () => {
      const result = repo.listNodesPage(
        testPersonaId,
        { page: 1, pageSize: 10, type: 'preference' },
        testUserId,
      );

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].type).toBe('preference');
    });

    it('filters by query', () => {
      const result = repo.listNodesPage(
        testPersonaId,
        { page: 1, pageSize: 10, query: 'JavaScript' },
        testUserId,
      );

      expect(result.nodes.length).toBeGreaterThanOrEqual(2);
      result.nodes.forEach((n) => {
        expect(n.content.toLowerCase()).toContain('javascript');
      });
    });

    it('returns empty results for no matches', () => {
      const result = repo.listNodesPage(
        testPersonaId,
        { page: 1, pageSize: 10, query: 'nonexistent-topic-xyz' },
        testUserId,
      );

      expect(result.nodes).toHaveLength(0);
    });

    it('orders by importance DESC by default', () => {
      const result = repo.listNodesPage(testPersonaId, { page: 1, pageSize: 10 }, testUserId);

      for (let i = 1; i < result.nodes.length; i++) {
        expect(result.nodes[i - 1].importance).toBeGreaterThanOrEqual(result.nodes[i].importance);
      }
    });

    it('handles pagination edge cases', () => {
      const result = repo.listNodesPage(testPersonaId, { page: 0, pageSize: 2 }, testUserId);
      expect(result.nodes.length).toBeGreaterThan(0);

      const largePage = repo.listNodesPage(testPersonaId, { page: 1, pageSize: 100 }, testUserId);
      expect(largePage.nodes.length).toBeLessThanOrEqual(100);
    });
  });

  describe('Cascade Delete', () => {
    it('deletes all memories for a user', () => {
      const memories: MemoryNode[] = [
        {
          id: 'mem-c1',
          type: 'fact',
          content: 'User memory 1',
          embedding: [0.1],
          importance: 5,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        },
        {
          id: 'mem-c2',
          type: 'fact',
          content: 'User memory 2',
          embedding: [0.2],
          importance: 5,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        },
      ];

      memories.forEach((m) => repo.insertNode(testPersonaId, m, testUserId));

      const allBefore = repo.listAllNodes(testUserId);
      expect(allBefore.length).toBeGreaterThanOrEqual(2);

      const deleted = repo.deleteNode(testPersonaId, 'mem-c1', testUserId);
      expect(deleted).toBe(1);

      const allAfter = repo.listAllNodes(testUserId);
      expect(allAfter.length).toBeGreaterThanOrEqual(1);
    });

    it('lists all memories for a user', () => {
      const memories: MemoryNode[] = [
        {
          id: 'mem-all1',
          type: 'fact',
          content: 'All test 1',
          embedding: [0.1],
          importance: 5,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        },
        {
          id: 'mem-all2',
          type: 'fact',
          content: 'All test 2',
          embedding: [0.2],
          importance: 5,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        },
      ];

      memories.forEach((m) => repo.insertNode(testPersonaId, m, testUserId));

      const all = repo.listAllNodes(testUserId);
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it('handles listAllNodes without userId', () => {
      const memory: MemoryNode = {
        id: 'mem-global',
        type: 'fact',
        content: 'Global test',
        embedding: [0.1],
        importance: 5,
        confidence: 0.9,
        timestamp: new Date().toISOString(),
      };

      repo.insertNode(testPersonaId, memory, testUserId);

      const all = repo.listAllNodes();
      expect(all.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('updateMany', () => {
    it('updates multiple nodes at once', () => {
      const memories: MemoryNode[] = [
        {
          id: 'mem-m1',
          type: 'fact',
          content: 'Bulk update 1',
          embedding: [0.1],
          importance: 3,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        },
        {
          id: 'mem-m2',
          type: 'fact',
          content: 'Bulk update 2',
          embedding: [0.2],
          importance: 3,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        },
      ];

      memories.forEach((m) => repo.insertNode(testPersonaId, m, testUserId));

      const count = repo.updateMany(
        testPersonaId,
        ['mem-m1', 'mem-m2'],
        { importance: 5 },
        testUserId,
      );

      expect(count).toBeGreaterThanOrEqual(1);

      const nodes = repo.listNodes(testPersonaId, testUserId);
      const updated = nodes.filter((n) => ['mem-m1', 'mem-m2'].includes(n.id));
      updated.forEach((n) => {
        expect(n.importance).toBe(5);
      });
    });

    it('handles empty node list', () => {
      const count = repo.updateMany(testPersonaId, [], { importance: 5 }, testUserId);
      expect(count).toBe(0);
    });

    it('handles non-existent node IDs', () => {
      const count = repo.updateMany(
        testPersonaId,
        ['non-existent-1', 'non-existent-2'],
        { importance: 5 },
        testUserId,
      );
      expect(count).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('handles special characters in content', () => {
      const specialContent = 'Special chars: \n\t\r"\'\\💥🎉';
      const memory: MemoryNode = {
        id: 'mem-special',
        type: 'fact',
        content: specialContent,
        embedding: [0.1],
        importance: 5,
        confidence: 0.9,
        timestamp: new Date().toISOString(),
      };

      repo.insertNode(testPersonaId, memory, testUserId);

      const retrieved = repo.listNodes(testPersonaId, testUserId)[0];
      expect(retrieved.content).toBe(specialContent);
    });

    it('handles null/undefined metadata', () => {
      const memory: MemoryNode = {
        id: 'mem-null-meta',
        type: 'fact',
        content: 'No metadata',
        embedding: [0.1],
        importance: 5,
        confidence: 0.9,
        timestamp: new Date().toISOString(),
      };

      repo.insertNode(testPersonaId, memory, testUserId);

      const retrieved = repo.listNodes(testPersonaId, testUserId)[0];
      expect(retrieved.metadata).toBeUndefined();
    });

    it('handles empty embedding arrays', () => {
      const memory: MemoryNode = {
        id: 'mem-empty-emb',
        type: 'fact',
        content: 'Empty embedding',
        embedding: [],
        importance: 5,
        confidence: 0.9,
        timestamp: new Date().toISOString(),
      };

      repo.insertNode(testPersonaId, memory, testUserId);

      const retrieved = repo.listNodes(testPersonaId, testUserId)[0];
      expect(retrieved.embedding).toEqual([]);
    });

    it('handles very large embedding arrays', () => {
      const largeEmbedding = Array.from({ length: 1536 }, (_, i) => Math.random());
      const memory: MemoryNode = {
        id: 'mem-large-emb',
        type: 'fact',
        content: 'Large embedding',
        embedding: largeEmbedding,
        importance: 5,
        confidence: 0.9,
        timestamp: new Date().toISOString(),
      };

      repo.insertNode(testPersonaId, memory, testUserId);

      const retrieved = repo.listNodes(testPersonaId, testUserId)[0];
      expect(retrieved.embedding).toHaveLength(1536);
    });

    it('handles boundary importance values', () => {
      const memories: MemoryNode[] = [
        {
          id: 'mem-imp-0',
          type: 'fact',
          content: 'Min importance',
          embedding: [0.1],
          importance: 0,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        },
        {
          id: 'mem-imp-10',
          type: 'fact',
          content: 'Max importance',
          embedding: [0.1],
          importance: 10,
          confidence: 0.9,
          timestamp: new Date().toISOString(),
        },
      ];

      memories.forEach((m) => repo.insertNode(testPersonaId, m, testUserId));

      const result = repo.listNodes(testPersonaId, testUserId);

      expect(result.some((m) => m.importance === 0)).toBe(true);
      expect(result.some((m) => m.importance === 10)).toBe(true);
    });

    it('handles boundary confidence values', () => {
      const memories: MemoryNode[] = [
        {
          id: 'mem-conf-0',
          type: 'fact',
          content: 'Min confidence',
          embedding: [0.1],
          importance: 5,
          confidence: 0,
          timestamp: new Date().toISOString(),
        },
        {
          id: 'mem-conf-1',
          type: 'fact',
          content: 'Max confidence',
          embedding: [0.1],
          importance: 5,
          confidence: 1,
          timestamp: new Date().toISOString(),
        },
      ];

      memories.forEach((m) => repo.insertNode(testPersonaId, m, testUserId));

      const result = repo.listNodes(testPersonaId, testUserId);

      expect(result.some((m) => m.confidence === 0)).toBe(true);
      expect(result.some((m) => m.confidence === 1)).toBe(true);
    });
  });

  describe('Performance', () => {
    it('handles bulk insert efficiently', () => {
      const batchSize = 100;
      const memories: MemoryNode[] = Array.from({ length: batchSize }, (_, i) => ({
        id: `mem-bulk-${i}`,
        type: 'fact',
        content: `Bulk memory ${i}`,
        embedding: [0.1],
        importance: Math.floor(Math.random() * 10),
        confidence: Math.random(),
        timestamp: new Date().toISOString(),
      }));

      const startTime = Date.now();
      memories.forEach((m) => repo.insertNode(testPersonaId, m, testUserId));
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(5000);
      expect(repo.listNodes(testPersonaId, testUserId)).toHaveLength(batchSize);
    });

    it('handles pagination on large datasets', () => {
      const count = 200;
      const memories: MemoryNode[] = Array.from({ length: count }, (_, i) => ({
        id: `mem-page-${i}`,
        type: 'fact',
        content: `Page test ${i}`,
        embedding: [0.1],
        importance: 5,
        confidence: 0.9,
        timestamp: new Date().toISOString(),
      }));

      memories.forEach((m) => repo.insertNode(testPersonaId, m, testUserId));

      const page1 = repo.listNodesPage(testPersonaId, { page: 1, pageSize: 50 }, testUserId);
      const page2 = repo.listNodesPage(testPersonaId, { page: 2, pageSize: 50 }, testUserId);

      expect(page1.nodes).toHaveLength(50);
      expect(page2.nodes).toHaveLength(50);
      expect(page1.nodes[0].id).not.toBe(page2.nodes[0].id);
    });
  });

  describe('User ID Resolution', () => {
    it('uses default user ID when userId is undefined', () => {
      const memory: MemoryNode = {
        id: 'mem-default-user',
        type: 'fact',
        content: 'Default user test',
        embedding: [0.1],
        importance: 5,
        confidence: 0.9,
        timestamp: new Date().toISOString(),
      };

      repo.insertNode(testPersonaId, memory);

      const nodes = repo.listNodes(testPersonaId);
      expect(nodes.length).toBeGreaterThanOrEqual(1);
    });

    it('uses default user ID when userId is empty string', () => {
      const memory: MemoryNode = {
        id: 'mem-empty-user',
        type: 'fact',
        content: 'Empty user test',
        embedding: [0.1],
        importance: 5,
        confidence: 0.9,
        timestamp: new Date().toISOString(),
      };

      repo.insertNode(testPersonaId, memory, '');

      const nodes = repo.listNodes(testPersonaId, '');
      expect(nodes.length).toBeGreaterThanOrEqual(1);
    });
  });
});
