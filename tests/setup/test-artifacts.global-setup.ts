import fs from 'node:fs';
import path from 'node:path';
import { cleanupTestArtifactsRoot } from '../../scripts/cleanup-test-artifacts';
import { getTestArtifactsRoot } from '../helpers/testArtifacts';

export interface TestArtifactsCleanupLifecycle {
  root: string;
  teardown: () => void;
}

export interface TestArtifactsCleanupLifecycleOptions {
  root: string;
  autoClean: boolean;
  keepArtifacts: boolean;
  allowAnyDir?: boolean;
}

export function parseBooleanEnvFlag(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (!normalized) return fallback;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

function cleanupRoot(root: string, allowAnyDir: boolean): void {
  cleanupTestArtifactsRoot({
    root,
    dryRun: false,
    allowAnyDir,
  });
  fs.mkdirSync(root, { recursive: true });
}

export function createTestArtifactsCleanupLifecycle(
  options: TestArtifactsCleanupLifecycleOptions,
): TestArtifactsCleanupLifecycle {
  const root = path.resolve(options.root);
  const allowAnyDir = options.allowAnyDir === true;

  if (options.autoClean) {
    cleanupRoot(root, allowAnyDir);
  } else {
    fs.mkdirSync(root, { recursive: true });
  }

  return {
    root,
    teardown: () => {
      if (!options.autoClean || options.keepArtifacts) return;
      cleanupRoot(root, allowAnyDir);
    },
  };
}

export default function setupTestArtifactsGlobalCleanup(): () => void {
  const root = getTestArtifactsRoot();
  const autoClean = parseBooleanEnvFlag(process.env.TEST_ARTIFACTS_AUTO_CLEAN, true);
  const keepArtifacts = parseBooleanEnvFlag(process.env.TEST_ARTIFACTS_KEEP, false);
  const allowAnyDir = parseBooleanEnvFlag(process.env.TEST_ARTIFACTS_ALLOW_ANY_DIR_CLEANUP, false);

  const lifecycle = createTestArtifactsCleanupLifecycle({
    root,
    autoClean,
    keepArtifacts,
    allowAnyDir,
  });

  return () => lifecycle.teardown();
}
