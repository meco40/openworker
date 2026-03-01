import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getTestArtifactsRoot,
  removeTestArtifactPath,
  testArtifactsPath,
  uniqueTestDbPath,
} from '../../helpers/testArtifacts';

describe('test artifact helpers', () => {
  const previousRoot = process.env.TEST_ARTIFACTS_ROOT;

  afterEach(() => {
    if (previousRoot === undefined) {
      delete process.env.TEST_ARTIFACTS_ROOT;
    } else {
      process.env.TEST_ARTIFACTS_ROOT = previousRoot;
    }
  });

  it('defaults to .local/test-artifacts root', () => {
    delete process.env.TEST_ARTIFACTS_ROOT;
    const root = getTestArtifactsRoot();
    expect(root).toBe(path.resolve('.local', 'test-artifacts'));
    expect(fs.existsSync(root)).toBe(true);
  });

  it('creates unique sqlite db paths under the db subdirectory', () => {
    const customRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-artifacts-root-'));
    process.env.TEST_ARTIFACTS_ROOT = customRoot;

    const one = uniqueTestDbPath('alpha');
    const two = uniqueTestDbPath('alpha');

    expect(one).not.toBe(two);
    expect(one.startsWith(path.join(customRoot, 'db'))).toBe(true);
    expect(two.startsWith(path.join(customRoot, 'db'))).toBe(true);
  });

  it('removes sqlite sidecars together with the base file', () => {
    const customRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-artifacts-remove-'));
    process.env.TEST_ARTIFACTS_ROOT = customRoot;

    const dbPath = testArtifactsPath('db', 'cleanup.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'base');
    fs.writeFileSync(`${dbPath}-wal`, 'wal');
    fs.writeFileSync(`${dbPath}-shm`, 'shm');

    removeTestArtifactPath(dbPath);

    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
  });
});
