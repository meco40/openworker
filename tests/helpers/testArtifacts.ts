import fs from 'node:fs';
import path from 'node:path';

const SQLITE_SIDECAR_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;

export function getTestArtifactsRoot(): string {
  const configured = String(process.env.TEST_ARTIFACTS_ROOT || '').trim();
  const root = configured ? path.resolve(configured) : path.resolve('.local', 'test-artifacts');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function testArtifactsPath(...segments: string[]): string {
  const root = getTestArtifactsRoot();
  const resolved = path.resolve(root, ...segments);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new Error('Resolved test artifact path is outside of TEST_ARTIFACTS_ROOT.');
  }
  return resolved;
}

export function uniqueTestDbPath(prefix: string): string {
  const safePrefix =
    String(prefix || 'test')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'test';
  const entropy = Math.random().toString(36).slice(2);
  return testArtifactsPath('db', `${safePrefix}.${Date.now()}.${entropy}.db`);
}

export function removeTestArtifactPath(targetPath: string): void {
  const resolvedTarget = path.resolve(targetPath);

  if (fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isDirectory()) {
    fs.rmSync(resolvedTarget, { recursive: true, force: true });
    return;
  }

  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const candidate = `${resolvedTarget}${suffix}`;
    try {
      if (fs.existsSync(candidate)) {
        fs.rmSync(candidate, { force: true });
      }
    } catch {
      // Ignore transient cleanup races on sqlite files.
    }
  }
}
