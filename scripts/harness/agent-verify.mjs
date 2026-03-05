import { appendFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const SCENARIO_SPECS = {
  'chat-stream': 'tests/e2e/browser/chat-smoke.spec.ts',
  'persona-switch': 'tests/e2e/browser/chat-queue-and-persona.spec.ts',
  'master-run-feedback': 'tests/e2e/browser/mission-control-run-feedback.spec.ts',
};

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

function resolveScenarioSpecs(selected) {
  if (selected.length === 0) {
    return Object.values(SCENARIO_SPECS);
  }
  return selected.map((name) => {
    const spec = SCENARIO_SPECS[name];
    if (!spec) {
      throw new Error(`Unknown scenario "${name}"`);
    }
    return spec;
  });
}

function runCommand(command, args, options, logFile) {
  appendFileSync(logFile, `\n$ ${command} ${args.join(' ')}\n`);
  const child = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'pipe',
    shell: process.platform === 'win32',
    encoding: 'utf8',
  });
  appendFileSync(logFile, child.stdout || '');
  appendFileSync(logFile, child.stderr || '');
  if (typeof child.status !== 'number' || child.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function hasNextBuild(workDir) {
  return existsSync(resolve(workDir, '.next', 'BUILD_ID'));
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

async function main() {
  const rootDir = process.cwd();
  const { scenarios, useWorktree } = parseArgs(process.argv.slice(2));
  const specs = resolveScenarioSpecs(scenarios);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactDir = resolve(rootDir, '.local', 'harness', stamp);
  mkdirSync(artifactDir, { recursive: true });
  const logFile = join(artifactDir, 'commands.log');
  writeFileSync(logFile, `Harness verify started at ${new Date().toISOString()}\n`, 'utf8');

  let workDir = rootDir;
  let worktreePath = null;
  let scheduler = null;

  try {
    if (useWorktree) {
      worktreePath = createWorktree(rootDir, stamp);
      workDir = worktreePath;
      appendFileSync(logFile, `[harness] using isolated worktree: ${workDir}\n`);
    } else {
      appendFileSync(logFile, '[harness] running in current workspace\n');
    }

    const env = {
      ...process.env,
      NODE_ENV: 'test',
      PLAYWRIGHT_PORT: process.env.PLAYWRIGHT_PORT || '3200',
      MEM0_MOCK_PORT: process.env.MEM0_MOCK_PORT || '18200',
    };

    if (useWorktree) {
      runCommand('pnpm', ['install', '--frozen-lockfile'], { cwd: workDir, env }, logFile);
    } else {
      appendFileSync(logFile, '[harness] skipping install in current workspace mode\n');
    }

    if (!hasNextBuild(workDir)) {
      runCommand('pnpm', ['run', 'build'], { cwd: workDir, env }, logFile);
    } else {
      appendFileSync(logFile, '[harness] reusing existing .next build\n');
    }

    scheduler = startScheduler(workDir, env, logFile);

    runCommand('pnpm', ['run', 'test:e2e:smoke'], { cwd: workDir, env }, logFile);
    runCommand('pnpm', ['exec', 'playwright', 'test', ...specs], { cwd: workDir, env }, logFile);

    copyArtifacts(workDir, artifactDir);
    appendFileSync(logFile, '[harness] verify completed successfully\n');
    console.log(`[harness] success - artifacts: ${artifactDir}`);
  } finally {
    stopChild(scheduler);
    if (worktreePath) {
      removeWorktree(rootDir, worktreePath);
    }
  }
}

main().catch((error) => {
  console.error('[harness] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
