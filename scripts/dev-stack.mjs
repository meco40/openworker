#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import { startManagedOllama, stopManagedOllama } from './ollama-lifecycle.mjs';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env');
loadEnvConfig(process.cwd());

function resolveNpmCliPath() {
  const envPath = String(process.env.npm_execpath || '').trim();
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const nodeDir = path.dirname(process.execPath);
  const candidates =
    process.platform === 'win32'
      ? [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      : [
          path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          path.join(nodeDir, '..', 'lib64', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolvePackageManagerInvocation() {
  const npmCliPath = resolveNpmCliPath();
  if (npmCliPath) {
    return {
      command: process.execPath,
      baseArgs: [npmCliPath],
      display: `${process.execPath} ${npmCliPath}`,
    };
  }

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return {
    command: npmCmd,
    baseArgs: [],
    display: npmCmd,
  };
}

const packageManager = resolvePackageManagerInvocation();

/** @type {{name: string, proc: import('node:child_process').ChildProcess}[]} */
const children = [];
let shuttingDown = false;
let exitCode = 0;
let ollamaProcess = null;

function startChild(name, args) {
  const commandArgs = [...packageManager.baseArgs, ...args];
  console.log(`[dev-stack] starting ${name}: ${packageManager.display} ${args.join(' ')}`);
  const proc = spawn(packageManager.command, commandArgs, {
    stdio: 'inherit',
    env: process.env,
  });
  children.push({ name, proc });

  proc.on('error', (error) => {
    console.error(`[dev-stack] failed to start ${name}:`, error);
    shutdown(1);
  });

  proc.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const normalizedCode = typeof code === 'number' ? code : signal ? 1 : 0;
    if (normalizedCode !== 0) {
      console.error(
        `[dev-stack] ${name} exited with code=${normalizedCode} signal=${signal ?? 'none'}`,
      );
    } else {
      console.error(`[dev-stack] ${name} exited`);
    }
    shutdown(normalizedCode);
  });
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
  const ollamaStop = stopManagedOllama(ollamaProcess).catch(() => {});

  const watcher = setInterval(() => {
    const allExited = children.every((child) => child.proc.exitCode !== null || child.proc.killed);
    if (!allExited) return;
    clearInterval(watcher);
    void ollamaStop.finally(() => process.exit(exitCode));
  }, 100);
  watcher.unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  ollamaProcess = await startManagedOllama();
  if (ollamaProcess) {
    children.push({ name: 'ollama', proc: ollamaProcess });
    ollamaProcess.once('exit', (code, signal) => {
      if (shuttingDown) return;
      console.error(
        `[dev-stack] ollama exited with code=${code ?? 'none'} signal=${signal ?? 'none'}`,
      );
      shutdown(1);
    });
  }
  startChild('web', ['run', 'dev:web']);
  startChild('scheduler', ['run', 'dev:scheduler']);
}

main().catch((error) => {
  console.error('[dev-stack] startup failed:', error);
  shutdown(1);
});
