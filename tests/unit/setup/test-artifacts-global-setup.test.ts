import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createTestArtifactsCleanupLifecycle,
  parseBooleanEnvFlag,
} from '../../setup/test-artifacts.global-setup';

const ALLOWED_ROOT = path.resolve('.local', 'test-artifacts');

function createRootDir(prefix: string): string {
  fs.mkdirSync(ALLOWED_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(ALLOWED_ROOT, prefix));
}

describe('test-artifacts global setup', () => {
  it('parses boolean env flags with defaults', () => {
    expect(parseBooleanEnvFlag(undefined, true)).toBe(true);
    expect(parseBooleanEnvFlag(undefined, false)).toBe(false);
    expect(parseBooleanEnvFlag('1', false)).toBe(true);
    expect(parseBooleanEnvFlag('true', false)).toBe(true);
    expect(parseBooleanEnvFlag('yes', false)).toBe(true);
    expect(parseBooleanEnvFlag('0', true)).toBe(false);
    expect(parseBooleanEnvFlag('false', true)).toBe(false);
    expect(parseBooleanEnvFlag('no', true)).toBe(false);
    expect(parseBooleanEnvFlag('unknown-value', true)).toBe(true);
    expect(parseBooleanEnvFlag('unknown-value', false)).toBe(false);
  });

  it('cleans before and after run by default', () => {
    const root = createRootDir('global-setup-cycle-');

    try {
      const staleFile = path.join(root, 'stale.db');
      fs.writeFileSync(staleFile, 'stale');

      const lifecycle = createTestArtifactsCleanupLifecycle({
        root,
        autoClean: true,
        keepArtifacts: false,
      });

      expect(fs.existsSync(staleFile)).toBe(false);

      const runFile = path.join(root, 'run.db');
      fs.writeFileSync(runFile, 'run');
      lifecycle.teardown();

      expect(fs.existsSync(runFile)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps files after run when keepArtifacts is enabled', () => {
    const root = createRootDir('global-setup-keep-');

    try {
      const lifecycle = createTestArtifactsCleanupLifecycle({
        root,
        autoClean: true,
        keepArtifacts: true,
      });

      const runFile = path.join(root, 'run.db');
      fs.writeFileSync(runFile, 'run');
      lifecycle.teardown();

      expect(fs.existsSync(runFile)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not clean when autoClean is disabled', () => {
    const root = createRootDir('global-setup-disabled-');

    try {
      const staleFile = path.join(root, 'stale.db');
      fs.writeFileSync(staleFile, 'stale');

      const lifecycle = createTestArtifactsCleanupLifecycle({
        root,
        autoClean: false,
        keepArtifacts: false,
      });

      expect(fs.existsSync(staleFile)).toBe(true);

      const runFile = path.join(root, 'run.db');
      fs.writeFileSync(runFile, 'run');
      lifecycle.teardown();

      expect(fs.existsSync(runFile)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
