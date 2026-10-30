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
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path, { dirname, resolve } from 'node:path';
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
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    // Standalone pnpm on Windows is a native .exe, not a JS entry point.
    if (npmExecPath.toLowerCase().endsWith('.exe')) {
      return { command: npmExecPath, baseArgs: [], display: npmExecPath };
    }
    return {
      command: process.execPath,
      baseArgs: [npmExecPath],
      display: `${process.execPath} ${npmExecPath}`,
    };
  }

  const appData = process.env.APPDATA || '';
  const pnpmCandidates = [path.join(appData, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')];
  for (const candidate of pnpmCandidates) {
    if (fs.existsSync(candidate)) {
      return {
        command: process.execPath,
        baseArgs: [candidate],
        display: `${process.execPath} ${candidate}`,
      };
    }
  }

  const nodeDir = path.dirname(process.execPath);
  const npmCandidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of npmCandidates) {
    if (fs.existsSync(candidate)) {
      return {
        command: process.execPath,
        baseArgs: [candidate],
        display: `${process.execPath} ${candidate}`,
      };
    }
  }

  const isWindows = process.platform === 'win32';
  const command = isWindows ? 'pnpm.cmd' : 'pnpm';
  return { command, baseArgs: [], display: command };
}

const packageManager = resolvePackageManagerInvocation();

function startChild(name, args, extraEnv = {}) {
  const commandArgs = [...packageManager.baseArgs, ...args];
  console.log(`[dev-stack] starting ${name}: ${packageManager.display} ${args.join(' ')}`);
  const isCmd = packageManager.command.endsWith('.cmd') || packageManager.command.endsWith('.bat');
  const proc = spawn(packageManager.command, commandArgs, {
    stdio: 'inherit',
    cwd: repoRoot,
    ...(isCmd ? { shell: true } : {}),
    env: { ...process.env, ...extraEnv, BETACLAW_DEV_CHILD: name },
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

// The world-model settings the gateway resolves itself (`world_model/config.rs`), so
// every set variable is passed under its own name and the precedence stays there.
const WORLD_MODEL_FLAGS = ['WORLD_MODEL_ENABLED', 'WORLD_MODEL_MODE', 'WORLD_MODEL_RUNTIME_ROLE'];
const DATABASE_URL_VARS = [
  'WORLD_MODEL_APP_DATABASE_URL',
  'CANONICAL_DATABASE_URL',
  'DATABASE_URL',
];
// Docker volume behind /app/.local in the dev gateway. scripts/dev-import-legacy.mjs uses
// the same name.
const DEV_DATA_VOLUME = 'betaclaw-dev-data';

// Returns the docker arguments and the environment of the docker process. Values never
// go into argv: a process listing would show the database password in the URLs.
function worldModelDockerEnv(isWindows) {
  const args = [];
  const env = {};
  for (const name of WORLD_MODEL_FLAGS) {
    // Name only: docker copies the value, and skips the variable when it is unset.
    args.push('-e', name);
  }
  for (const name of DATABASE_URL_VARS) {
    const raw = (process.env[name] || '').trim();
    if (!raw) continue;
    // Inside the container, loopback is the container itself, not the host database.
    env[name] = isWindows
      ? raw.replace(/@(127\.0\.0\.1|localhost)(:\d+)?\//, '@host.docker.internal$2/')
      : raw;
    args.push('-e', name);
  }
  return { args, env };
}

/**
 * Starts the Rust gateway from its release binary.
 *
 * `cargo` is intentionally not invoked from the host: the toolchain lives in a
 * container image. The binary is expected at rust/target/release/betaclaw-gateway.
 *
 * Returns false when the stack must abort, so callers stop before spawning the
 * UI and scheduler. Otherwise returns 'host' or 'docker', the way the gateway runs.
 */
function startRustGateway(port, isStaticMode, staticDir) {
  const binary = resolve(repoRoot, 'rust', 'target', 'release', 'betaclaw-gateway');
  const isWindows = process.platform === 'win32';
  const binaryPath = isWindows ? `${binary}.exe` : binary;

  let proc;
  let viaDocker = false;
  console.log(`[dev-stack] checking Rust gateway binary at ${binaryPath}`);
  const check = spawnSync(binaryPath, ['--version'], { stdio: 'ignore' });
  if (!check.error) {
    console.log(`[dev-stack] starting gateway: ${binaryPath}`);
    proc = spawn(binaryPath, [], {
      stdio: 'inherit',
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(port),
        HOSTNAME: '127.0.0.1',
        GATEWAY_UPSTREAM_ORIGIN: `http://127.0.0.1:${UI_PORT}`,
        RUST_LOG: process.env.RUST_LOG || 'info',
        BETACLAW_UI_MODE: process.env.BETACLAW_UI_MODE,
        UI_STATIC_DIR: staticDir,
      },
    });
  } else {
    const dockerCheck = spawnSync('docker', ['image', 'inspect', 'betaclaw-gateway-local'], {
      stdio: 'ignore',
    });
    if (dockerCheck.status === 0) {
      console.log(
        `[dev-stack] host binary not directly executable on ${process.platform}, using container 'betaclaw-gateway-local'`,
      );
      spawnSync('docker', ['rm', '-f', 'betaclaw-dev-gateway'], { stdio: 'ignore' });
      const upstream = isWindows
        ? `http://host.docker.internal:${UI_PORT}`
        : `http://127.0.0.1:${UI_PORT}`;
      const staticMount =
        isStaticMode && fs.existsSync(staticDir)
          ? ['-v', `${staticDir.replace(/\\/g, '/')}:/app/out:ro`]
          : [];
      const worldModel = worldModelDockerEnv(isWindows);
      const dockerArgs = [
        'run',
        '--rm',
        '--name',
        'betaclaw-dev-gateway',
        '-p',
        `127.0.0.1:${port}:3000`,
        ...(isWindows ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
        ...staticMount,
        // Persistent data of the Rust gateway (auth, personas, model hub). The host .local
        // stays with the Node UI; `pnpm run dev:import-legacy` fills this volume.
        '-v',
        `${DEV_DATA_VOLUME}:/app/.local`,
        '-e',
        'PORT=3000',
        '-e',
        'HOSTNAME=0.0.0.0',
        '-e',
        `GATEWAY_UPSTREAM_ORIGIN=${upstream}`,
        '-e',
        `RUST_LOG=${process.env.RUST_LOG || 'info'}`,
        '-e',
        'NODE_ENV=development',
        '-e',
        'REQUIRE_AUTH=false',
        '-e',
        'WORKSPACE_ROOT=/app',
        '-e',
        'CLAWHUB_WORKDIR=/app/clawhub',
        '-e',
        'EXTERNAL_SKILLS_ENABLED=false',
        // Name only: docker copies the value from the stack env (.env.local), so the
        // gateway and the UI decode the same session cookies and share background job ownership.
        '-e',
        'NEXTAUTH_SECRET',
        // The gateway answers /api/auth itself and seeds the first admin from these, so the
        // container needs them to accept the login of the default user.
        '-e',
        'AUTH_DEFAULT_EMAIL',
        '-e',
        'AUTH_DEFAULT_PASSWORD',
        '-e',
        'AUTH_DEFAULT_NAME',
        // Name only: the model hub decrypts its stored secrets with this key.
        '-e',
        'MODEL_HUB_ENCRYPTION_KEY',
        '-e',
        'BETACLAW_TELEGRAM_POLLER',
        '-e',
        'BETACLAW_SWARM_RUNNER',
        '-e',
        'BETACLAW_WORKSPACE_CLEANUP',
        '-e',
        'BETACLAW_UI_MODE',
        ...worldModel.args,
        'betaclaw-gateway-local',
      ];
      proc = spawn('docker', dockerArgs, {
        stdio: 'inherit',
        env: { ...process.env, ...worldModel.env },
      });
      viaDocker = true;
    } else {
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
  }

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
  return viaDocker ? 'docker' : 'host';
}

/**
 * Starts the Rust scheduler from its release binary when present, falling back
 * to the TypeScript scheduler (`dev:scheduler`) when not yet extracted.
 */
function rustSchedulerBinary() {
  const binary = resolve(repoRoot, 'rust', 'target', 'release', 'betaclaw-scheduler');
  const binaryPath = process.platform === 'win32' ? `${binary}.exe` : binary;
  return spawnSync(binaryPath, ['--version'], { stdio: 'ignore' }).error ? null : binaryPath;
}

function startRustScheduler(binaryPath) {
  if (!binaryPath) {
    startChild('scheduler', ['run', 'dev:scheduler']);
    return;
  }

  console.log(`[dev-stack] starting Rust scheduler: ${binaryPath}`);
  const proc = spawn(binaryPath, [], {
    stdio: 'inherit',
    cwd: repoRoot,
    env: {
      ...process.env,
      BETACLAW_DEV_CHILD: 'scheduler',
      RUST_LOG: process.env.RUST_LOG || 'info',
    },
  });
  children.push({ name: 'scheduler', proc });

  proc.on('error', (error) => {
    console.error('[dev-stack] failed to start scheduler:', error);
    shutdown(1);
  });
  proc.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev-stack] scheduler exited with code=${code} signal=${signal ?? 'none'}`);
    shutdown(code ?? 1);
  });
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
  try {
    spawnSync('docker', ['rm', '-f', 'betaclaw-dev-gateway'], { stdio: 'ignore' });
  } catch {
    // ignore
  }
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

  const isStaticMode =
    process.argv.includes('--static') ||
    String(process.env.BETACLAW_UI_MODE || '').toLowerCase() === 'static';
  const uiMode = isStaticMode ? 'static' : process.env.BETACLAW_UI_MODE || 'proxy';
  process.env.BETACLAW_UI_MODE = uiMode;

  const staticDir = resolve(repoRoot, process.env.UI_STATIC_DIR || 'out');
  console.log(`[ui] mode=${uiMode} dir=${staticDir}`);

  if (isStaticMode) {
    console.log('[dev-stack] building the current static UI export...');
    const buildRes = spawnSync(
      packageManager.command,
      [...packageManager.baseArgs, 'run', 'build:export'],
      {
        cwd: repoRoot,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      },
    );
    if (buildRes.status !== 0) {
      console.error('[dev-stack] static UI build:export failed');
      shutdown(1);
      return;
    }
  }

  // Fail fast on a busy port instead of letting the child die with a bare
  // "address in use". Port 3000 is a common conflict with other applications.
  const gatewayPort = resolveGatewayPort();
  const isFree = await assertPortFree(gatewayPort);
  if (!isFree) return;
  console.log(`[dev-stack] gateway will listen on http://127.0.0.1:${gatewayPort}`);

  const gateway = startRustGateway(gatewayPort, isStaticMode, staticDir);
  if (!gateway) return;
  const schedulerBinary = rustSchedulerBinary();
  // Only a containerised gateway needs a non-loopback UI listener (host.docker.internal).
  const uiEnv = { HOSTNAME: gateway === 'docker' ? '0.0.0.0' : '127.0.0.1' };
  // Rust runs the workspace cleanup in its scheduler only. Without that binary the
  // TS scheduler takes over, which has no cleanup, so the Node UI server owns it.
  const cleanupOwner = String(process.env.BETACLAW_WORKSPACE_CLEANUP || '')
    .trim()
    .toLowerCase();
  if (!schedulerBinary && cleanupOwner === 'rust') {
    if (isStaticMode) {
      console.warn(
        '[dev-stack] no Rust scheduler binary: workspace cleanup does not run in static mode',
      );
    } else {
      console.log('[dev-stack] no Rust scheduler binary: workspace cleanup owner=node (web-ui)');
      uiEnv.BETACLAW_WORKSPACE_CLEANUP = 'node';
    }
  }
  if (!isStaticMode) {
    startChild('web-ui', ['run', 'dev:web-ui'], uiEnv);
  } else {
    console.log('[dev-stack] static UI mode active — web-ui (Node) process omitted');
  }
  startRustScheduler(schedulerBinary);
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
