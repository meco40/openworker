import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const project = 'betaclaw-release-smoke-' + randomBytes(4).toString('hex');
const image = process.env.RELEASE_SMOKE_IMAGE || project + ':candidate';
const logDir = process.env.RELEASE_SMOKE_LOG_DIR || path.join(os.tmpdir(), project);
fs.mkdirSync(logDir, { recursive: true });
const env = {
  ...process.env,
  RELEASE_SMOKE_IMAGE: image,
  POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
  WORLD_MODEL_APP_ROLE_PASSWORD: randomBytes(32).toString('hex'),
  WORLD_MODEL_WORKER_ROLE_PASSWORD: randomBytes(32).toString('hex'),
  NEXTAUTH_SECRET: randomBytes(32).toString('hex'),
  MODEL_HUB_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  AUTH_DEFAULT_EMAIL: 'release@example.invalid',
  AUTH_DEFAULT_PASSWORD: randomBytes(32).toString('hex'),
  NEXTAUTH_URL: 'http://web:3000',
  SCHEDULER_HEALTH_TOKEN: '',
  WORLD_MODEL_DISPATCH_SCOPES: '',
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
  if (options.capture) return result.stdout + result.stderr;
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error('Docker command failed: ' + args[0] + ' (exit ' + result.status + ')');
}
try {
  if (!process.env.RELEASE_SMOKE_IMAGE) run(['build', '-t', image, '.']);
  run([...compose, 'up', '-d', '--no-build', '--wait', '--wait-timeout', '180', 'scheduler']);
  run([...compose, 'run', '--rm', '--no-deps', '--use-aliases', 'probe']);
  run([
    ...compose,
    'exec',
    '-T',
    'scheduler',
    'node',
    '--import',
    'tsx',
    '--input-type=module',
    '-e',
    `import assert from 'node:assert/strict';
     const {runWithWorldModelScope, getWorldModelDb, closeWorldModelDb} = await import('./src/server/world-model/db.ts');
     const {insertOpenLoop, insertStandingIntent, registerStandingIntentFire} = await import('./src/server/world-model/repositories/prospectiveRepository.ts');
     const {runProspectiveRuntimeOnce} = await import('./src/server/world-model/runtime/prospectiveRuntime.ts');
     const scope = {userId: 'release-worker-' + Date.now(), personaId: 'release', workspaceId: ''};
     process.env.WORLD_MODEL_DISPATCH_SCOPES = scope.userId + ':release:';
     assert.equal(process.env.WORLD_MODEL_RUNTIME_ROLE, 'worker');
     try {
       assert.equal((await getWorldModelDb().query('SELECT current_user AS role')).rows[0].role, 'world_model_worker');
       await runWithWorldModelScope(scope, async () => {
         await insertOpenLoop({...scope, type: 'clarification', question: 'Synthetic release question', importance: 1, deduplicationKey: scope.userId, maxAttempts: 2});
         const intent = await insertStandingIntent({...scope, description: 'Synthetic release intent', triggerTerms: ['release'], cooldownMs: 0, maxFires: 1, deduplicationKey: scope.userId});
         await registerStandingIntentFire(intent.id, new Date().toISOString());
       });
       const result = await runProspectiveRuntimeOnce();
       assert(result.openLoopsDelivered >= 1, JSON.stringify(result));
       console.log(JSON.stringify({ok: true, workerRole: true, proactive: result}));
     } finally { await closeWorldModelDb(); }`,
  ]);
  run([
    ...compose,
    'exec',
    '-T',
    'web',
    'node',
    '--import',
    'tsx',
    '--input-type=module',
    '-e',
    `import assert from 'node:assert/strict';
     const {pythonExecuteHandler, buildPythonCommand} = await import('./src/server/skills/handlers/pythonExecute.ts');
     const {multiToolUseParallelHandler} = await import('./src/server/skills/handlers/multiToolUseParallel.ts');
     const {approveCommand} = await import('./src/server/gateway/exec-approval-manager.ts');
     const code = 'print("python-runtime-ok")';
     await assert.rejects(pythonExecuteHandler({code}), /requires approval/);
     approveCommand(buildPythonCommand(code));
     const result = await pythonExecuteHandler({code});
     assert.equal(result.exitCode, 0); assert.equal(result.stdout.trim(), 'python-runtime-ok');
     const nested = await multiToolUseParallelHandler({tool_uses: [{name: 'python_execute', args: {code}}]});
     assert.equal(nested.results[0].result.exitCode, 0);
     console.log(JSON.stringify({ok: true, python: true, rejectedBeforeApproval: true, approvedDirectAndNested: true}));`,
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
    'web',
    'node',
    'node_modules/playwright/cli.js',
    'screenshot',
    'data:text/html,release-browser-ok',
    '/tmp/release-browser.png',
  ]);
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
    run([...compose, 'logs', '--no-color'], { capture: true }),
  );
  run([...compose, 'down', '--volumes']);
}
