import { createRequire } from 'node:module';
import { closeWorldModelDb, runWorldModelMigrations } from '../src/server/world-model/db';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string) => unknown;
};
loadEnvConfig(process.cwd());

void (async () => {
  try {
    console.log('Applied World-Model migrations:', await runWorldModelMigrations());
  } finally {
    await closeWorldModelDb();
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
