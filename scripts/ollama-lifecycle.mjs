#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_MODEL = 'qwen2.5:7b';
const DEFAULT_HOST = '0.0.0.0:11434';
const DEFAULT_PORT = 11434;
const STARTUP_TIMEOUT_MS = 60_000;
const WARMUP_TIMEOUT_MS = 120_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTrue(value) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );
}

function shouldManageOllama() {
  if (process.env.OLLAMA_LIFECYCLE_ENABLED !== undefined) {
    return isTrue(process.env.OLLAMA_LIFECYCLE_ENABLED);
  }

  const baseUrl = String(process.env.GRAPHITI_OPENAI_BASE_URL ?? '').toLowerCase();
  return baseUrl.includes(':11434') || baseUrl.includes('localhost:11434');
}

function resolvePort() {
  const configuredHost = String(process.env.OLLAMA_HOST ?? DEFAULT_HOST).trim();
  const portMatch = configuredHost.match(/:(\d+)$/);
  return Number(process.env.OLLAMA_PORT ?? portMatch?.[1] ?? DEFAULT_PORT);
}

function resolveApiUrl(port) {
  return String(process.env.OLLAMA_API_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, '');
}

function resolveExecutable() {
  const configured = String(process.env.OLLAMA_EXECUTABLE ?? '').trim();
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const candidates = [
    configured,
    ...(process.platform === 'win32'
      ? [
          localAppData ? `${localAppData}\\Programs\\Ollama\\ollama.exe` : '',
          programFiles ? `${programFiles}\\Ollama\\ollama.exe` : '',
        ]
      : []),
    process.platform === 'win32' ? 'ollama.exe' : 'ollama',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!candidate.includes('\\') && !candidate.includes('/') && process.platform !== 'win32') {
      return candidate;
    }
    if (fs.existsSync(candidate)) return candidate;
  }

  return candidates[candidates.length - 1];
}

async function fetchJson(apiUrl, path, timeoutMs = 3_000) {
  const response = await fetch(`${apiUrl}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Ollama HTTP ${response.status} for ${path}`);
  }
  return await response.json();
}

async function postJson(apiUrl, path, payload, timeoutMs = WARMUP_TIMEOUT_MS) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Ollama HTTP ${response.status} for ${path}`);
  }
  return await response.json();
}

async function waitForApi(apiUrl, child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`Ollama exited during startup with code ${child.exitCode}.`);
    }

    try {
      await fetchJson(apiUrl, '/api/version');
      return;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }

  throw new Error(
    `Ollama did not become ready within ${STARTUP_TIMEOUT_MS}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function getListeningPids(port) {
  if (process.platform === 'win32') {
    const command = [
      '$ErrorActionPreference = "SilentlyContinue";',
      `@(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique)`,
      '| ConvertTo-Json -Compress',
    ].join(' ');
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        command,
      ]);
      if (!stdout.trim()) return [];
      const parsed = JSON.parse(stdout.trim());
      return (Array.isArray(parsed) ? parsed : [parsed])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0);
    } catch {
      return [];
    }
  }

  try {
    const { stdout } = await execFileAsync('sh', [
      '-c',
      `lsof -t -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true`,
    ]);
    return stdout
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

async function describeProcess(pid) {
  if (process.platform === 'win32') {
    const command = `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object Name,CommandLine | ConvertTo-Json -Compress`;
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        command,
      ]);
      return stdout.trim() ? JSON.parse(stdout.trim()) : null;
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm=,args=']);
    const [name = '', ...args] = stdout.trim().split(/\s+/);
    return { Name: name, CommandLine: args.join(' ') };
  } catch {
    return null;
  }
}

async function stopPid(pid) {
  if (process.platform === 'win32') {
    await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Stop-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    ]).catch(() => {});
    await sleep(1_000);
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F']).catch(() => {});
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // The process may already have exited.
  }
}

async function stopExistingOllama(port) {
  if (!isTrue(process.env.OLLAMA_LIFECYCLE_EXCLUSIVE ?? 'true')) return;

  const pids = await getListeningPids(port);
  for (const pid of pids) {
    const details = await describeProcess(pid);
    const name = String(details?.Name ?? '');
    const commandLine = String(details?.CommandLine ?? '');
    if (!/ollama(?:\.exe)?$/i.test(name) || !/\bserve\b/i.test(commandLine)) continue;

    console.log(`[ollama] stopping existing server pid=${pid} on port ${port}`);
    await stopPid(pid);
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function ensureModel(executable, apiUrl, model) {
  const tags = await fetchJson(apiUrl, '/api/tags');
  const models = Array.isArray(tags?.models) ? tags.models : [];
  if (models.some((entry) => entry?.name === model)) return;

  console.log(`[ollama] model ${model} is missing; downloading it now`);
  const result = await runProcess(executable, ['pull', model], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.code !== 0) {
    throw new Error(`Ollama model pull failed with code ${result.code ?? result.signal}.`);
  }
}

async function warmModel(apiUrl, model) {
  const result = await postJson(apiUrl, '/api/generate', {
    model,
    prompt: '',
    stream: false,
    think: false,
    keep_alive: -1,
    options: { num_predict: 1 },
  });
  const running = await fetchJson(apiUrl, '/api/ps');
  const loaded = Array.isArray(running?.models)
    ? running.models.some((entry) => entry?.name === model || entry?.model === model)
    : false;
  if (!loaded) {
    throw new Error(`Ollama warm-up completed, but ${model} is not listed by /api/ps.`);
  }
  const loadSeconds = Number(result?.load_duration ?? 0) / 1_000_000_000;
  console.log(
    `[ollama] warmed ${model} and kept it loaded${loadSeconds > 0 ? ` (load ${loadSeconds.toFixed(1)}s)` : ''}`,
  );
}

/**
 * Starts the app-owned Ollama server and ensures the configured local model
 * exists. The returned process is owned by the caller and must be terminated
 * during app shutdown.
 */
export async function startManagedOllama() {
  if (!shouldManageOllama()) return null;

  const port = resolvePort();
  const apiUrl = resolveApiUrl(port);
  const model = String(process.env.OLLAMA_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const executable = resolveExecutable();
  await stopExistingOllama(port);

  const child = spawn(executable, ['serve'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      OLLAMA_HOST: process.env.OLLAMA_HOST || DEFAULT_HOST,
      OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL || '1',
      OLLAMA_CONTEXT_LENGTH: process.env.OLLAMA_CONTEXT_LENGTH || '32768',
      OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE || '-1',
    },
  });

  console.log(`[ollama] starting ${executable} serve on ${apiUrl}`);
  try {
    await waitForApi(apiUrl, child);
    await ensureModel(executable, apiUrl, model);
    await warmModel(apiUrl, model);
  } catch (error) {
    await stopManagedOllama(child);
    throw error;
  }
  console.log(`[ollama] ready with model ${model}`);
  return child;
}

export async function stopManagedOllama(child) {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined)) return;
  await stopPid(child.pid);
}
