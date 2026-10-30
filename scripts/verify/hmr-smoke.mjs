/** Run in an isolated source copy: edits LoginForm temporarily to prove proxy HMR. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const origin = process.env.GATEWAY_BASE_URL;
assert(origin, 'Set the isolated Rust gateway URL.');
const file = 'app/login/LoginForm.tsx',
  original = readFileSync(file, 'utf8');
assert(original.includes('>Sign In</h1>'));
const next = spawn(
  process.execPath,
  [
    'node_modules/next/dist/bin/next',
    'dev',
    '--turbopack',
    '--hostname',
    '0.0.0.0',
    '--port',
    '3013',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' },
  },
);
let browser;
try {
  const deadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin + '/login', { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(ready, 'Next dev did not become reachable through Rust.');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(),
    sockets = [];
  page.on('websocket', (socket) => sockets.push(socket.url()));
  await page.goto(origin + '/login');
  await page.getByRole('heading', { name: 'Sign In', exact: true }).waitFor();
  writeFileSync(file, original.replace('>Sign In</h1>', '>HMR verification</h1>'));
  await page
    .getByRole('heading', { name: 'HMR verification', exact: true })
    .waitFor({ timeout: 60000 });
  assert(
    sockets.some((url) => new URL(url).host === new URL(origin).host && /\/_next\/.*hmr/.test(url)),
    'No proxied HMR WebSocket: ' + JSON.stringify(sockets),
  );
  console.log(
    JSON.stringify({ ok: true, rustProxy: origin, hmrWebSocket: true, sourceChangeRendered: true }),
  );
} finally {
  writeFileSync(file, original);
  await browser?.close();
  next.kill('SIGTERM');
}
