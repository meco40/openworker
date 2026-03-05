import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const SCENARIO_MATRIX_PATH = 'docs/contracts/DOMAIN_SCENARIO_MATRIX.json';
const DEFAULT_SCENARIOS = ['chat-stream', 'persona-switch', 'master-run-feedback'];

function parseArgs(argv) {
  const scenarios = [];
  let useWorktree = process.env.HARNESS_USE_WORKTREE !== '0';

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--scenario') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('Missing value for --scenario');
      }
      scenarios.push(next);
      index += 1;
      continue;
    }
    if (token === '--no-worktree') {
      useWorktree = false;
      continue;
    }
  }

  return { scenarios, useWorktree };
}

function readScenarioMatrix(rootDir) {
  const absolute = resolve(rootDir, SCENARIO_MATRIX_PATH);
  const parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  const scenarios = Array.isArray(parsed?.scenarios) ? parsed.scenarios : [];
  const map = new Map();
  for (const scenario of scenarios) {
    const id = String(scenario?.id || '').trim();
    const command = String(scenario?.command || '').trim();
    if (!id || !command) continue;
    map.set(id, {
      id,
      runner: String(scenario?.runner || 'shell').trim() || 'shell',
      command,
      domains: Array.isArray(scenario?.domains)
        ? scenario.domains.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [],
    });
  }
  return map;
}

function resolveScenarios(selected, matrix) {
  const requested = selected.length > 0 ? selected : DEFAULT_SCENARIOS;
  return requested.map((id) => {
    const scenario = matrix.get(id);
    if (!scenario) {
      throw new Error(`Unknown scenario "${id}". Check ${SCENARIO_MATRIX_PATH}.`);
    }
    return scenario;
  });
}

function runCommandString(command, options, logFile) {
  appendFileSync(logFile, `\n$ ${command}\n`);
  const child = spawnSync(command, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'pipe',
    shell: true,
    encoding: 'utf8',
  });
  appendFileSync(logFile, child.stdout || '');
  appendFileSync(logFile, child.stderr || '');
  if (typeof child.status !== 'number' || child.status !== 0) {
    throw new Error(`Command failed: ${command}`);
  }
}

function hasNextBuild(workDir) {
  return existsSync(resolve(workDir, '.next', 'BUILD_ID'));
}

function gitValue(workDir, command) {
  const child = spawnSync('git', command.split(' '), {
    cwd: workDir,
    shell: process.platform === 'win32',
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (typeof child.status !== 'number' || child.status !== 0) return '';
  return String(child.stdout || '').trim();
}

function startScheduler(cwd, env, logFile) {
  const child = spawn('node', ['--import', 'tsx', 'scheduler.ts'], {
    cwd,
    env,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
  child.stdout.on('data', (chunk) => appendFileSync(logFile, String(chunk)));
  child.stderr.on('data', (chunk) => appendFileSync(logFile, String(chunk)));
  return child;
}

function stopChild(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
}

function createWorktree(rootDir, suffix) {
  const worktreePath = resolve(rootDir, '.worktrees', `harness-verify-${suffix}`);
  mkdirSync(resolve(rootDir, '.worktrees'), { recursive: true });
  const result = spawnSync('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], {
    cwd: rootDir,
    stdio: 'pipe',
    shell: process.platform === 'win32',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Failed to create worktree: ${result.stderr || result.stdout}`);
  }
  return worktreePath;
}

function removeWorktree(rootDir, worktreePath) {
  spawnSync('git', ['worktree', 'remove', '--force', worktreePath], {
    cwd: rootDir,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
}

function copyArtifacts(workDir, artifactDir) {
  const sources = ['test-results', 'playwright-report'];
  for (const source of sources) {
    const from = resolve(workDir, source);
    if (!existsSync(from)) continue;
    const to = resolve(artifactDir, source);
    cpSync(from, to, { recursive: true, force: true });
  }
}

function writeJson(filePath, payload) {
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function buildIsolatedEnv(baseEnv, artifactDir, worktreeId) {
  const dbRoot = resolve(artifactDir, 'db');
  const uploadsRoot = resolve(artifactDir, 'uploads', 'chat');
  const personasRoot = resolve(artifactDir, 'personas');
  const workspacesRoot = resolve(artifactDir, 'workspaces');
  mkdirSync(dbRoot, { recursive: true });
  mkdirSync(uploadsRoot, { recursive: true });
  mkdirSync(personasRoot, { recursive: true });
  mkdirSync(workspacesRoot, { recursive: true });

  const basePort = 3300 + Math.floor(Math.random() * 200);
  return {
    ...baseEnv,
    NODE_ENV: 'test',
    HARNESS_WORKTREE_ID: worktreeId,
    PORT: String(basePort),
    PLAYWRIGHT_PORT: String(basePort + 1),
    MEM0_MOCK_PORT: String(basePort + 2),
    DATABASE_PATH: resolve(dbRoot, 'mission-control.db'),
    MESSAGES_DB_PATH: resolve(dbRoot, 'messages.db'),
    PERSONAS_DB_PATH: resolve(dbRoot, 'personas.db'),
    STATS_DB_PATH: resolve(dbRoot, 'stats.db'),
    AUTH_DB_PATH: resolve(dbRoot, 'auth.db'),
    MODEL_HUB_DB_PATH: resolve(dbRoot, 'model-hub.db'),
    SKILLS_DB_PATH: resolve(dbRoot, 'skills.db'),
    CLAWHUB_DB_PATH: resolve(dbRoot, 'clawhub.db'),
    LOGS_DB_PATH: resolve(dbRoot, 'logs.db'),
    AUTOMATION_DB_PATH: resolve(dbRoot, 'automation.db'),
    PROACTIVE_DB_PATH: resolve(dbRoot, 'proactive.db'),
    MEMORY_DB_PATH: resolve(dbRoot, 'memory.db'),
    KNOWLEDGE_DB_PATH: resolve(dbRoot, 'knowledge.db'),
    MASTER_DB_PATH: resolve(dbRoot, 'master.db'),
    OPENCLAW_CONFIG_PATH: resolve(dbRoot, 'gateway-config.json'),
    PERSONAS_ROOT_PATH: personasRoot,
    CHAT_ATTACHMENTS_DIR: uploadsRoot,
    TASK_WORKSPACES_ROOT: workspacesRoot,
    HARNESS_ARTIFACT_DIR: artifactDir,
  };
}

async function main() {
  const rootDir = process.cwd();
  const { scenarios, useWorktree } = parseArgs(process.argv.slice(2));
  const matrix = readScenarioMatrix(rootDir);
  const selectedScenarios = resolveScenarios(scenarios, matrix);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactDir = resolve(rootDir, '.local', 'harness', stamp);
  mkdirSync(artifactDir, { recursive: true });

  const logFile = join(artifactDir, 'commands.log');
  const scenarioMatrixOut = join(artifactDir, 'scenario-matrix.json');
  const runSummaryOut = join(artifactDir, 'run-summary.json');
  writeFileSync(logFile, `Harness verify started at ${new Date().toISOString()}\n`, 'utf8');

  let workDir = rootDir;
  let worktreePath = null;
  let scheduler = null;

  const runSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    worktreeId: null,
    commitSha: null,
    exitReason: null,
    bootOrder: [],
    scenarioIds: selectedScenarios.map((scenario) => scenario.id),
    scenarios: [],
    success: false,
    artifactDir,
  };

  try {
    if (useWorktree) {
      worktreePath = createWorktree(rootDir, stamp);
      workDir = worktreePath;
      runSummary.worktreeId = `harness-${stamp}`;
      appendFileSync(logFile, `[harness] using isolated worktree: ${workDir}\n`);
    } else {
      runSummary.worktreeId = 'workspace-current';
      appendFileSync(logFile, '[harness] running in current workspace\n');
    }

    const env = buildIsolatedEnv(process.env, artifactDir, runSummary.worktreeId);
    appendFileSync(
      logFile,
      `[harness] isolated env configured (PORT=${env.PORT}, PLAYWRIGHT_PORT=${env.PLAYWRIGHT_PORT}, MEM0_MOCK_PORT=${env.MEM0_MOCK_PORT})\n`,
    );

    runSummary.commitSha = gitValue(workDir, 'rev-parse HEAD');

    if (useWorktree) {
      runSummary.bootOrder.push('pnpm install --frozen-lockfile');
      runCommandString('pnpm install --frozen-lockfile', { cwd: workDir, env }, logFile);
    } else {
      appendFileSync(logFile, '[harness] skipping install in current workspace mode\n');
    }

    if (!hasNextBuild(workDir)) {
      runSummary.bootOrder.push('pnpm run build');
      runCommandString('pnpm run build', { cwd: workDir, env }, logFile);
    } else {
      appendFileSync(logFile, '[harness] reusing existing .next build\n');
    }

    runSummary.bootOrder.push('node --import tsx scheduler.ts');
    scheduler = startScheduler(workDir, env, logFile);

    runSummary.bootOrder.push('pnpm run test:e2e:smoke');
    runCommandString('pnpm run test:e2e:smoke', { cwd: workDir, env }, logFile);

    for (const scenario of selectedScenarios) {
      const startedAt = new Date().toISOString();
      try {
        runCommandString(scenario.command, { cwd: workDir, env }, logFile);
        runSummary.scenarios.push({
          id: scenario.id,
          runner: scenario.runner,
          command: scenario.command,
          domains: scenario.domains,
          status: 'success',
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      } catch (error) {
        runSummary.scenarios.push({
          id: scenario.id,
          runner: scenario.runner,
          command: scenario.command,
          domains: scenario.domains,
          status: 'failure',
          error: error instanceof Error ? error.message : String(error),
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        runSummary.exitReason = `scenario_failed:${scenario.id}`;
        throw error;
      }
    }

    copyArtifacts(workDir, artifactDir);
    runSummary.success = true;
    runSummary.exitReason = 'success';
    appendFileSync(logFile, '[harness] verify completed successfully\n');
    console.log(`[harness] success - artifacts: ${artifactDir}`);
  } finally {
    stopChild(scheduler);
    if (worktreePath) {
      removeWorktree(rootDir, worktreePath);
    }
    if (!runSummary.exitReason) {
      runSummary.exitReason = runSummary.success ? 'success' : 'failed';
    }
    runSummary.finishedAt = new Date().toISOString();
    writeJson(scenarioMatrixOut, {
      source: SCENARIO_MATRIX_PATH,
      selectedScenarioIds: runSummary.scenarioIds,
      scenarios: selectedScenarios,
    });
    writeJson(runSummaryOut, runSummary);
  }
}

main().catch((error) => {
  console.error('[harness] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
