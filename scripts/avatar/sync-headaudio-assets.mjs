import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const targetDir = path.join(repoRoot, 'public', 'vendor', 'headaudio');
const targetWorklet = path.join(targetDir, 'headworklet.mjs');
const targetModel = path.join(targetDir, 'model-en-mixed.bin');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyOrThrow(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing source file: ${source}`);
  }
  fs.copyFileSync(source, destination);
}

function main() {
  const packageJsonPath = require.resolve('@met4citizen/headaudio/package.json', {
    paths: [repoRoot],
  });
  const packageRoot = path.dirname(packageJsonPath);

  const sourceWorklet = path.join(packageRoot, 'dist', 'headworklet.min.mjs');
  const sourceModel = path.join(packageRoot, 'dist', 'model-en-mixed.bin');

  ensureDir(targetDir);
  copyOrThrow(sourceWorklet, targetWorklet);
  copyOrThrow(sourceModel, targetModel);

  process.stdout.write(
    `[avatar:sync-headaudio] Synced ${path.relative(repoRoot, targetWorklet)} and ${path.relative(repoRoot, targetModel)}\n`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[avatar:sync-headaudio] ${message}\n`);
  process.exit(1);
}
