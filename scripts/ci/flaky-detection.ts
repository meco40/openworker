import { spawnSync } from 'node:child_process';

interface RunResult {
  attempt: number;
  exitCode: number;
}

function runSmoke(attempt: number): RunResult {
  const child = spawnSync('pnpm', ['run', 'test:e2e:smoke'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
  });

  return {
    attempt,
    exitCode: typeof child.status === 'number' ? child.status : 1,
  };
}

function main(): void {
  const first = runSmoke(1);
  const second = runSmoke(2);

  console.log(`[flaky-detection] attempt=${first.attempt} exit=${first.exitCode}`);
  console.log(`[flaky-detection] attempt=${second.attempt} exit=${second.exitCode}`);

  if (first.exitCode !== second.exitCode) {
    console.error('[flaky-detection] Inconsistent outcomes detected (possible flake).');
    process.exit(1);
  }

  if (first.exitCode !== 0) {
    console.error('[flaky-detection] Smoke suite failed in both attempts.');
    process.exit(first.exitCode);
  }
}

main();
