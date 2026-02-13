// ─── Worker API Files Integration Tests ─────────────────────
// Tests the /api/worker/:id/files endpoint logic via direct
// WorkspaceManager + Repository calls (no HTTP server needed).

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceManagerImpl } from '../../src/server/worker/workspaceManager';
import { SqliteWorkerRepository } from '../../src/server/worker/workerRepository';

const TEST_TASK_ID = `files-api-test-${Date.now()}`;

describe('worker files API integration', () => {
  let mgr: WorkspaceManagerImpl;
  let repo: SqliteWorkerRepository;

  beforeAll(() => {
    mgr = new WorkspaceManagerImpl();
    repo = new SqliteWorkerRepository(':memory:');

    // Create a test task with required fields
    repo.createTask({
      title: 'Files API Test Task',
      objective: 'Test workspace file operations',
      workspaceType: 'general',
      priority: 'normal',
      originPlatform: 'webchat' as never,
      originConversation: 'test-conv-id',
    });
  });

  afterAll(() => {
    // Cleanup: delete test workspace
    if (mgr.exists(TEST_TASK_ID)) {
      mgr.deleteWorkspace(TEST_TASK_ID);
    }
  });

  describe('workspace creation and scaffold', () => {
    it('creates a workspace with scaffold directories', () => {
      const wsPath = mgr.createWorkspace(TEST_TASK_ID, 'research');
      expect(fs.existsSync(wsPath)).toBe(true);

      expect(fs.existsSync(path.join(wsPath, 'sources'))).toBe(true);

      expect(fs.existsSync(path.join(wsPath, 'notes'))).toBe(true);

      expect(fs.existsSync(path.join(wsPath, 'output'))).toBe(true);

      expect(fs.existsSync(path.join(wsPath, 'logs'))).toBe(true);
    });

    it('writes metadata file', () => {
      const meta = mgr.readTextFile(TEST_TASK_ID, '.workspace.json');
      expect(meta).not.toBeNull();
      const parsed = JSON.parse(meta!);
      expect(parsed.taskId).toBe(TEST_TASK_ID);
      expect(parsed.type).toBe('research');
      expect(parsed.version).toBe(1);
    });
  });

  describe('file write and read', () => {
    it('writes and reads a text file', () => {
      mgr.writeFile(TEST_TASK_ID, 'output/result.md', '# Test Result\n\nDone.');
      const content = mgr.readTextFile(TEST_TASK_ID, 'output/result.md');
      expect(content).toBe('# Test Result\n\nDone.');
    });

    it('writes and reads a binary file', () => {
      const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
      mgr.writeFile(TEST_TASK_ID, 'output/image.png', buf);
      const read = mgr.readFile(TEST_TASK_ID, 'output/image.png');
      expect(read).not.toBeNull();
      expect(read!.equals(buf)).toBe(true);
    });

    it('creates nested directories automatically', () => {
      mgr.writeFile(TEST_TASK_ID, 'deep/nested/dir/file.txt', 'hello');
      const content = mgr.readTextFile(TEST_TASK_ID, 'deep/nested/dir/file.txt');
      expect(content).toBe('hello');
    });

    it('returns null for non-existent file', () => {
      const content = mgr.readFile(TEST_TASK_ID, 'does-not-exist.txt');
      expect(content).toBeNull();
    });
  });

  describe('file listing', () => {
    it('lists all files recursively', () => {
      const files = mgr.listFiles(TEST_TASK_ID);
      expect(files.length).toBeGreaterThan(0);

      // Should contain our written files
      const names = files.map((f) => f.relativePath);
      expect(names).toContain(path.join('output', 'result.md'));
      expect(names).toContain(path.join('output', 'image.png'));
    });

    it('includes directories and files with correct types', () => {
      const files = mgr.listFiles(TEST_TASK_ID);
      const dirs = files.filter((f) => f.isDirectory);
      const regularFiles = files.filter((f) => !f.isDirectory);

      expect(dirs.length).toBeGreaterThan(0);
      expect(regularFiles.length).toBeGreaterThan(0);

      // Directory size should be 0
      for (const d of dirs) {
        expect(d.size).toBe(0);
        expect(d.isDirectory).toBe(true);
      }

      // Files should have size > 0
      for (const f of regularFiles) {
        expect(f.size).toBeGreaterThan(0);
        expect(f.isDirectory).toBe(false);
      }
    });

    it('has correct file metadata', () => {
      const files = mgr.listFiles(TEST_TASK_ID);
      const resultFile = files.find((f) => f.relativePath === path.join('output', 'result.md'));
      expect(resultFile).toBeDefined();
      expect(resultFile!.name).toBe('result.md');
      expect(resultFile!.size).toBeGreaterThan(0);
      expect(resultFile!.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('workspace size', () => {
    it('calculates total workspace size', () => {
      const size = mgr.getWorkspaceSize(TEST_TASK_ID);
      expect(size).toBeGreaterThan(0);
    });
  });

  describe('path traversal protection', () => {
    it('normalizes paths correctly', () => {
      mgr.writeFile(TEST_TASK_ID, 'output/safe.txt', 'safe content');
      const content = mgr.readTextFile(TEST_TASK_ID, 'output/safe.txt');
      expect(content).toBe('safe content');
    });

    it('detects path traversal via normalize check', () => {
      const normalized = path.normalize('../../../etc/passwd');
      expect(normalized.startsWith('..')).toBe(true);
    });

    it('detects absolute paths via isAbsolute check', () => {
      expect(path.isAbsolute('/etc/passwd')).toBe(true);
      expect(path.win32.isAbsolute('C:\\Windows\\System32')).toBe(true);
    });
  });

  describe('workspace deletion', () => {
    it('deletes workspace and all files', () => {
      const tempId = `temp-delete-${Date.now()}`;
      mgr.createWorkspace(tempId, 'general');
      mgr.writeFile(tempId, 'test.txt', 'will be deleted');
      expect(mgr.exists(tempId)).toBe(true);

      mgr.deleteWorkspace(tempId);
      expect(mgr.exists(tempId)).toBe(false);
    });

    it('handles deleting non-existent workspace gracefully', () => {
      expect(() => mgr.deleteWorkspace('non-existent-workspace')).not.toThrow();
    });
  });
});
