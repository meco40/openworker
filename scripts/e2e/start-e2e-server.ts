import fs, { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import {
  RustBackend,
  rustBinaryPath,
  startMem0MockServer,
  UI_EXPORT_DIR,
} from '../../tests/e2e/_shared/rustGateway';

/**
 * Web server of the browser lane (`playwright.config.ts`). Starts the Rust gateway in
 * static UI mode and the Rust scheduler on PORT, against a temp data dir and the mem0
 * mock, and stays up until Playwright stops it.
 *
 * Needs the binaries (`node scripts/e2e/prepare-rust-gateway.mjs`) and the UI export
 * (`pnpm run build:export`); `pnpm run test:e2e:browser` runs both first.
 */
async function main(): Promise<void> {
  for (const name of ['betaclaw-gateway', 'betaclaw-scheduler'] as const) {
    if (!fs.existsSync(rustBinaryPath(name))) {
      throw new Error(
        `Missing ${rustBinaryPath(name)}. Run: node scripts/e2e/prepare-rust-gateway.mjs`,
      );
    }
  }
  if (!fs.existsSync(path.join(UI_EXPORT_DIR, 'index.html'))) {
    throw new Error(`Missing UI export ${UI_EXPORT_DIR}. Run: pnpm run build:export`);
  }

  const appPort = Number(process.env.PORT || 3000);
  const mem0Port = Number(process.env.MEM0_MOCK_PORT || 18010);
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'openworker-browser-e2e-'));

  const mem0Server: http.Server = await startMem0MockServer(mem0Port);
  const backend = await RustBackend.start({
    port: appPort,
    mem0Port,
    dataDir: tempDir,
    forwardLogs: true,
  });

  const cleanup = () => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures for temp dirs
    }
  };

  const shutdown = () => {
    void backend.stop().then(() => {
      mem0Server.close(() => {
        cleanup();
        process.exit(0);
      });
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('exit', () => {
    backend.killNow();
    cleanup();
  });
}

void main();
