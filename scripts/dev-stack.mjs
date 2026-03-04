#!/usr/bin/env node

import { spawn } from 'node:child_process';

const npmCmd = 'npm';

/** @type {{name: string, proc: import('node:child_process').ChildProcess}[]} */
const children = [];
let shuttingDown = false;
let exitCode = 0;

function startChild(name, args) {
  console.log(`[dev-stack] starting ${name}: ${npmCmd} ${args.join(' ')}`);
  const proc = spawn(npmCmd, args, {
    stdio: 'inherit',
    env: process.env,
    shell: true,
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
    try {
      proc.kill('SIGKILL');
    } catch {
      // ignore
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

startChild('web', ['run', 'dev:web']);
startChild('scheduler', ['run', 'dev:scheduler']);
