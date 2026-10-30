import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const project = 'betaclaw-release-smoke-' + randomBytes(4).toString('hex');
const image = process.env.RELEASE_SMOKE_IMAGE || project + ':candidate';
const probeImage = process.env.RELEASE_SMOKE_PROBE_IMAGE || project + ':probe';
const logDir = process.env.RELEASE_SMOKE_LOG_DIR || path.join(os.tmpdir(), project);
fs.mkdirSync(logDir, { recursive: true });
const env = {
  ...process.env,
  RELEASE_SMOKE_IMAGE: image,
  RELEASE_SMOKE_PROBE_IMAGE: probeImage,
  POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
  WORLD_MODEL_APP_ROLE_PASSWORD: randomBytes(32).toString('hex'),
  WORLD_MODEL_WORKER_ROLE_PASSWORD: randomBytes(32).toString('hex'),
  NEXTAUTH_SECRET: randomBytes(32).toString('hex'),
  MODEL_HUB_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  AUTH_DEFAULT_EMAIL: 'release@example.invalid',
  AUTH_DEFAULT_PASSWORD: randomBytes(32).toString('hex'),
  NEXTAUTH_URL: 'http://gateway:3000',
  SCHEDULER_HEALTH_TOKEN: '',
  WORLD_MODEL_DISPATCH_SCOPES: '',
  RUST_LOG: 'info',
};
const compose = [
  'compose',
  '-p',
  project,
  '-f',
  'docker-compose.yml',
  '-f',
  'docker-compose.release-smoke.yml',
];
function run(args, options = {}) {
  const result = spawnSync('docker', args, {
    env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (options.capture) {
    if (result.status !== 0 && !options.allowFailure)
      throw new Error(result.stdout + result.stderr);
    return options.stdoutOnly ? result.stdout : result.stdout + result.stderr;
  }
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error('Docker command failed: ' + args[0] + ' (exit ' + result.status + ')');
}
try {
  if (!process.env.RELEASE_SMOKE_IMAGE)
    run(['build', '-f', 'docker/Dockerfile.gateway', '-t', image, '.']);
  if (!process.env.RELEASE_SMOKE_PROBE_IMAGE) run(['build', '-t', probeImage, '.']);
  run([...compose, 'up', '-d', '--no-build', '--wait', '--wait-timeout', '180', 'scheduler']);
  run([...compose, 'run', '--rm', '--no-deps', '--use-aliases', 'probe']);
  run([...compose, 'exec', '-T', 'gateway', 'python3', '-c', 'print("python-runtime-ok")']);
  run([
    ...compose,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'betaclaw_admin',
    '-d',
    'betaclaw',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    "SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename='world_model_worker') THEN 1 ELSE 0 END AS rust_worker_connected",
  ]);
  run([
    ...compose,
    'exec',
    '-T',
    'postgres',
    'sh',
    '-ec',
    'pg_dump -U betaclaw_admin -d betaclaw -Fc -f /tmp/release.dump; createdb -U betaclaw_admin release_restore; pg_restore --exit-on-error -U betaclaw_admin -d release_restore /tmp/release.dump; test "$(psql -U betaclaw_admin -d release_restore -Atc "SELECT count(*) FROM world_model_memory_items")" -gt 0; echo postgres-restore-ok',
  ]);
  run([
    ...compose,
    'exec',
    '-T',
    'gateway',
    'node',
    '/opt/betaclaw-tools/node_modules/playwright/cli.js',
    'screenshot',
    'data:text/html,release-browser-ok',
    '/tmp/release-browser.png',
  ]);
  if (process.argv.includes('--benchmark')) {
    run([...compose, '--profile', 'legacy-node-ui', 'up', '-d', '--no-build', '--wait', 'web-ui']);
    fs.writeFileSync(
      path.join(logDir, 'benchmark.json'),
      run(
        [
          ...compose,
          'run',
          '--rm',
          '--no-deps',
          'probe',
          'node',
          'scripts/verify/node-elimination-benchmark.mjs',
        ],
        { capture: true, stdoutOnly: true },
      ),
    );
    fs.writeFileSync(
      path.join(logDir, 'benchmark-memory.jsonl'),
      run(
        [
          'stats',
          '--no-stream',
          '--format',
          '{{json .}}',
          project + '-gateway-1',
          project + '-scheduler-1',
          project + '-web-ui-1',
          project + '-postgres-1',
        ],
        { capture: true },
      ),
    );
  }
  console.log(
    JSON.stringify({
      ok: true,
      project,
      image,
      logDir,
      freshDatabase: true,
      productionAuth: true,
      python: true,
      chromium: true,
    }),
  );
} finally {
  fs.writeFileSync(
    path.join(logDir, 'compose.log'),
    run([...compose, 'logs', '--no-color'], { capture: true, allowFailure: true }),
  );
  run([...compose, '--profile', 'legacy-node-ui', 'down', '--volumes']);
}
