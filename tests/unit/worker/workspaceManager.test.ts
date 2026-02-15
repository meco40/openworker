import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceManagerImpl } from '../../../src/server/worker/workspaceManager';

const TEST_ROOT = path.join(process.cwd(), 'workspaces');

describe('WorkspaceManager', () => {
  let mgr: WorkspaceManagerImpl;
  const testTaskId = 'test-task-' + Date.now();
  const customRoot = path.join(process.cwd(), '.tmp', `workspace-root-${Date.now()}`);

  beforeEach(() => {
    mgr = new WorkspaceManagerImpl();
  });

  afterEach(() => {
    // Cleanup test workspace
    const wsPath = mgr.getWorkspacePath(testTaskId);
    if (fs.existsSync(wsPath)) {
      fs.rmSync(wsPath, { recursive: true, force: true });
    }
    if (fs.existsSync(customRoot)) {
      fs.rmSync(customRoot, { recursive: true, force: true });
    }
  });

  describe('createWorkspace', () => {
    it('should create workspace directory with metadata', () => {
      const wsPath = mgr.createWorkspace(testTaskId, 'general');

      expect(fs.existsSync(wsPath)).toBe(true);
      expect(wsPath).toBe(path.join(TEST_ROOT, testTaskId));

      // Check metadata file
      const metaPath = path.join(wsPath, '.workspace.json');
      expect(fs.existsSync(metaPath)).toBe(true);

      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      expect(meta.taskId).toBe(testTaskId);
      expect(meta.type).toBe('general');
      expect(meta.version).toBe(1);
    });

    it('should scaffold research workspace with sources and notes dirs', () => {
      const wsPath = mgr.createWorkspace(testTaskId, 'research');

      expect(fs.existsSync(path.join(wsPath, 'sources'))).toBe(true);
      expect(fs.existsSync(path.join(wsPath, 'notes'))).toBe(true);
      expect(fs.existsSync(path.join(wsPath, 'output'))).toBe(true);
      expect(fs.existsSync(path.join(wsPath, 'logs'))).toBe(true);
    });

    it('should scaffold webapp workspace', () => {
      const wsPath = mgr.createWorkspace(testTaskId, 'webapp');

      expect(fs.existsSync(path.join(wsPath, 'output'))).toBe(true);
      expect(fs.existsSync(path.join(wsPath, 'logs'))).toBe(true);
    });

    it('should scaffold creative workspace with assets dir', () => {
      const wsPath = mgr.createWorkspace(testTaskId, 'creative');

      expect(fs.existsSync(path.join(wsPath, 'assets'))).toBe(true);
      expect(fs.existsSync(path.join(wsPath, 'output'))).toBe(true);
    });

    it('should scaffold data workspace with input dir', () => {
      const wsPath = mgr.createWorkspace(testTaskId, 'data');

      expect(fs.existsSync(path.join(wsPath, 'input'))).toBe(true);
      expect(fs.existsSync(path.join(wsPath, 'output'))).toBe(true);
    });
  });

  describe('exists', () => {
    it('should return false for non-existent workspace', () => {
      expect(mgr.exists('non-existent-task')).toBe(false);
    });

    it('should return true for existing workspace', () => {
      mgr.createWorkspace(testTaskId, 'general');
      expect(mgr.exists(testTaskId)).toBe(true);
    });
  });

  describe('writeFile / readFile', () => {
    it('should write and read text files', () => {
      mgr.createWorkspace(testTaskId, 'general');
      mgr.writeFile(testTaskId, 'output/report.md', '# My Report\nHello World');

      const content = mgr.readTextFile(testTaskId, 'output/report.md');
      expect(content).toBe('# My Report\nHello World');
    });

    it('should write and read binary files', () => {
      mgr.createWorkspace(testTaskId, 'creative');
      const imgData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
      mgr.writeFile(testTaskId, 'output/image.png', imgData);

      const read = mgr.readFile(testTaskId, 'output/image.png');
      expect(read).not.toBeNull();
      expect(Buffer.compare(read!, imgData)).toBe(0);
    });

    it('should auto-create nested directories', () => {
      mgr.createWorkspace(testTaskId, 'general');
      mgr.writeFile(testTaskId, 'deep/nested/dir/file.txt', 'content');

      const content = mgr.readTextFile(testTaskId, 'deep/nested/dir/file.txt');
      expect(content).toBe('content');
    });

    it('should return null for non-existent file', () => {
      mgr.createWorkspace(testTaskId, 'general');
      const result = mgr.readFile(testTaskId, 'does-not-exist.txt');
      expect(result).toBeNull();
    });
  });

  describe('listFiles', () => {
    it('should list all files recursively', () => {
      mgr.createWorkspace(testTaskId, 'general');
      mgr.writeFile(testTaskId, 'output/file1.txt', 'a');
      mgr.writeFile(testTaskId, 'output/sub/file2.txt', 'b');

      const files = mgr.listFiles(testTaskId);
      const filePaths = files.map((f) => f.relativePath);

      expect(filePaths).toContain('.workspace.json');
      expect(filePaths).toContain(path.join('output', 'file1.txt'));
      expect(filePaths).toContain(path.join('output', 'sub', 'file2.txt'));
    });

    it('should distinguish files and directories', () => {
      mgr.createWorkspace(testTaskId, 'general');
      mgr.writeFile(testTaskId, 'output/file.txt', 'data');

      const files = mgr.listFiles(testTaskId);
      const outputDir = files.find((f) => f.name === 'output');
      const txtFile = files.find((f) => f.name === 'file.txt');

      expect(outputDir?.isDirectory).toBe(true);
      expect(txtFile?.isDirectory).toBe(false);
      expect(txtFile?.size).toBeGreaterThan(0);
    });

    it('should return empty array for non-existent workspace', () => {
      expect(mgr.listFiles('non-existent')).toEqual([]);
    });
  });

  describe('deleteWorkspace', () => {
    it('should remove workspace folder completely', () => {
      mgr.createWorkspace(testTaskId, 'general');
      mgr.writeFile(testTaskId, 'output/file.txt', 'data');

      expect(mgr.exists(testTaskId)).toBe(true);
      mgr.deleteWorkspace(testTaskId);
      expect(mgr.exists(testTaskId)).toBe(false);
    });

    it('should not throw for non-existent workspace', () => {
      expect(() => mgr.deleteWorkspace('non-existent')).not.toThrow();
    });
  });

  describe('getWorkspaceSize', () => {
    it('should compute correct total size', () => {
      mgr.createWorkspace(testTaskId, 'general');
      mgr.writeFile(testTaskId, 'output/a.txt', 'Hello'); // 5 bytes
      mgr.writeFile(testTaskId, 'output/b.txt', 'World!'); // 6 bytes

      const size = mgr.getWorkspaceSize(testTaskId);
      // At minimum the metadata file + 2 text files
      expect(size).toBeGreaterThanOrEqual(11);
    });
  });

  describe('cross-platform paths', () => {
    it('should use path.join for workspace path', () => {
      const wsPath = mgr.getWorkspacePath('my-task');
      expect(wsPath).toBe(path.join(TEST_ROOT, 'my-task'));

      // Should never contain hardcoded separators that don't match OS
      if (process.platform === 'win32') {
        expect(wsPath).not.toContain('/');
      }
    });

    it('supports a custom workspace root path', () => {
      const wsPath = mgr.createWorkspace(testTaskId, 'general', { rootDir: customRoot });

      expect(wsPath).toBe(path.join(customRoot, testTaskId));
      expect(fs.existsSync(path.join(customRoot, testTaskId, '.workspace.json'))).toBe(true);
    });
  });
});
