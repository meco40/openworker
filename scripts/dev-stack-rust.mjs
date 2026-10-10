#!/usr/bin/env node
/**
 * Developer stack for the Rust migration.
 *
 * Starts three processes:
 *   - `gateway`  the Rust axum gateway, owns http://127.0.0.1:3000 and /ws
 *   - `web-ui`   Next.js on 127.0.0.1:3001, serving the UI and the API routes
 *                that have not been migrated yet
 *   - `scheduler` the TypeScript scheduler, unchanged until slice S13
 *
 * The Rust gateway is compiled inside a container so no host toolchain is
 * required. See docs/RUST_MIGRATION.md.
 *
 * Environment:
 *   BETACLAW_DEV_GATEWAY=off   start the legacy Node gateway only (pnpm dev:node)
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const { loadEnvConfig } = require('@next/env');
loadEnvConfig(repoRoot);

const UI_PORT = Number.parseInt(String(process.env.WEB_UI_PORT || '3001'), 10);

const children = [];
let shuttingDown = false;
let exitCode = 0;

function resolvePackageManagerInvocation() {
  const npmExecPath = String(process.env.npm_execpath || '').trim();
  if (npmExecPath) {
    return {
      command: process.execPath,
      baseArgs: [npmExecPath],
      display: `${process.execPath} ${npmExecPath}`,
    };
  }
  const isWindows = process.platform === 'win32';
  const command = isWindows ? 'npm.cmd' : 'npm';
  return { command, baseArgs: [], display: command };
}

const packageManager = resolvePackageManagerInvocation();

function startChild(name, args) {
  const commandArgs = [...packageManager.baseArgs, ...args];
  console.log(`[dev-stack] starting ${name}: ${packageManager.display} ${args.join(' ')}`);
  const proc = spawn(packageManager.command, commandArgs, {
    stdio: 'inherit',
    cwd: repoRoot,
    env: { ...process.env, BETACLAW_DEV_CHILD: name },
  });
  children.push({ name, proc });

  proc.on('error', (error) => {
    console.error(`[dev-stack] failed to start ${name}:`, error);
    shutdown(1);
  });

  proc.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const normalizedCode = code ?? (signal ? 1 : 0);
    console.error(
      `[dev-stack] ${name} exited with code=${normalizedCode} signal=${signal ?? 'none'}`,
    );
    shutdown(normalizedCode);
  });
}

/**
 * Starts the Rust gateway from its release binary.
 *
 * `cargo` is intentionally not invoked from the host: the toolchain lives in a
 * container image. The binary is expected at rust/target/release/betaclaw-gateway.
 *
 * Returns false when the stack must abort, so callers stop before spawning the
 * UI and scheduler.
 */
function startRustGateway(port) {
  const binary = resolve(repoRoot, 'rust', 'target', 'release', 'betaclaw-gateway');
  const isWindows = process.platform === 'win32';
  const binaryPath = isWindows ? `${binary}.exe` : binary;

  console.log(`[dev-stack] checking Rust gateway binary at ${binaryPath}`);
  const check = spawnSync(binaryPath, ['--version'], { stdio: 'ignore' });
  if (check.error) {
    console.error(
      '[dev-stack] Rust gateway binary not found.\n' +
        '          Build it in a container first:\n' +
        '            pnpm run rust:build\n' +
        '            docker create --name betaclaw-gateway-extract betaclaw-gateway-local\n' +
        '            docker cp betaclaw-gateway-extract:/workspace/rust/target/release/betaclaw-gateway rust/target/release/\n' +
        '            docker rm betaclaw-gateway-extract\n' +
        '          Or run the whole stack in containers: docker compose up -d\n',
    );
    shutdown(1);
    return false;
  }

  console.log(`[dev-stack] starting gateway: ${binaryPath}`);
  const proc = spawn(binaryPath, [], {
    stdio: 'inherit',
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      GATEWAY_UPSTREAM_ORIGIN: `http://127.0.0.1:${UI_PORT}`,
      RUST_LOG: process.env.RUST_LOG || 'info',
    },
  });
  children.push({ name: 'gateway', proc });

  proc.on('error', (error) => {
    console.error('[dev-stack] failed to start gateway:', error);
    shutdown(1);
  });
  proc.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev-stack] gateway exited with code=${code} signal=${signal ?? 'none'}`);
    if (code === 1) {
      console.error(
        '[dev-stack] The gateway most likely could not bind its port. See the log above.',
      );
    }
    shutdown(code ?? 1);
  });
  return true;
}

/**
 * Resolves the public gateway port.
 *
 * Port 3000 is the documented default but a common conflict on developer
 * machines, so GATEWAY_PORT overrides it. The browser derives the WebSocket URL
 * from `window.location.host`, so no client change is needed.
 */
function resolveGatewayPort() {
  const raw = String(process.env.GATEWAY_PORT || process.env.PORT || '3000').trim();
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 3000;
}

function terminateChild(proc) {
  if (proc.exitCode !== null || proc.killed) return;
  try {
    proc.kill('SIGTERM');
  } catch {
    // ignore
  }

  setTimeout(() => {
    if (proc.exitCode !== null || proc.killed) return;
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }, 2000).unref();
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  for (const child of children) {
    terminateChild(child.proc);
  }

  const watcher = setInterval(() => {
    const allExited = children.every((child) => child.proc.exitCode !== null || child.proc.killed);
    if (!allExited) return;
    clearInterval(watcher);
    process.exit(exitCode);
  }, 100);
  watcher.unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  if (String(process.env.BETACLAW_DEV_GATEWAY || 'on').toLowerCase() === 'off') {
    console.log('[dev-stack] Rust gateway disabled — starting the legacy Node stack');
    startChild('web', ['run', 'dev:web']);
    startChild('scheduler', ['run', 'dev:scheduler']);
    return;
  }

  // Fail fast on a busy port instead of letting the child die with a bare
  // "address in use". Port 3000 is a common conflict with other applications.
  const gatewayPort = resolveGatewayPort();
  const isFree = await assertPortFree(gatewayPort);
  if (!isFree) return;
  console.log(`[dev-stack] gateway will listen on http://127.0.0.1:${gatewayPort}`);

  if (!startRustGateway(gatewayPort)) return;
  startChild('web-ui', ['run', 'dev:web-ui']);
  startChild('scheduler', ['run', 'dev:scheduler']);
}

main();

/** Resolves true when the port is free, false when the caller should abort. */
function assertPortFree(port) {
  return new Promise((resolvePromise) => {
    const probe = net.createServer();
    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(
          `\n[dev-stack] Port ${port} is already in use, so the Rust gateway cannot start.\n` +
            '            Either stop the other application, or pick a free port:\n' +
            `              $env:GATEWAY_PORT = '${port === 3000 ? '3100' : port + 1}'\n` +
            '            The browser derives the WebSocket URL from the page origin,\n' +
            '            so no client configuration has to change.\n',
        );
        shutdown(1);
        resolvePromise(false);
        return;
      }
      console.error(`[dev-stack] failed to probe port ${port}:`, error.message);
      shutdown(1);
      resolvePromise(false);
    });
    probe.once('listening', () => {
      probe.close(() => resolvePromise(true));
    });
    probe.listen(port, '127.0.0.1');
  });
}
