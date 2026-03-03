import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAllowedExistingPath } from '@/server/security/fileAccess';

describe('resolveAllowedExistingPath', () => {
  let workspaceRoot = '';
  let projectRoot = '';
  let originalWorkspaceRoot: string | undefined;
  let originalProjectsPath: string | undefined;

  beforeEach(() => {
    originalWorkspaceRoot = process.env.WORKSPACE_BASE_PATH;
    originalProjectsPath = process.env.PROJECTS_PATH;

    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-file-workspace-'));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-file-project-'));
    process.env.WORKSPACE_BASE_PATH = workspaceRoot;
    process.env.PROJECTS_PATH = projectRoot;
  });

  afterEach(() => {
    if (originalWorkspaceRoot === undefined) delete process.env.WORKSPACE_BASE_PATH;
    else process.env.WORKSPACE_BASE_PATH = originalWorkspaceRoot;
    if (originalProjectsPath === undefined) delete process.env.PROJECTS_PATH;
    else process.env.PROJECTS_PATH = originalProjectsPath;

    if (workspaceRoot) fs.rmSync(workspaceRoot, { recursive: true, force: true });
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('accepts paths inside allowed roots', () => {
    const targetPath = path.join(workspaceRoot, 'preview.html');
    fs.writeFileSync(targetPath, '<html>ok</html>');

    const result = resolveAllowedExistingPath(targetPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedPath).toContain('preview.html');
    }
  });

  it('rejects sibling prefix traversal patterns', () => {
    const baseDir = path.dirname(workspaceRoot);
    const sibling = path.join(baseDir, `${path.basename(workspaceRoot)}-evil`);
    fs.mkdirSync(sibling, { recursive: true });
    const targetPath = path.join(sibling, 'preview.html');
    fs.writeFileSync(targetPath, '<html>blocked</html>');

    const result = resolveAllowedExistingPath(targetPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }

    fs.rmSync(sibling, { recursive: true, force: true });
  });

  it('rejects non-existing paths', () => {
    const result = resolveAllowedExistingPath(path.join(workspaceRoot, 'missing.html'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
    }
  });
});
