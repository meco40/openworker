/** Both servers must be isolated, authenticated peers in the same Compose network. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
const email = process.env.AUTH_DEFAULT_EMAIL,
  password = process.env.AUTH_DEFAULT_PASSWORD;
assert(email && password, 'Use the isolated benchmark admin credentials.');
const origins = {
  rust: process.env.BENCH_RUST_ORIGIN || 'http://gateway:3000',
  node: process.env.BENCH_NODE_ORIGIN || 'http://web-ui:3001',
};
async function client(origin) {
  const cookies = new Map();
  const request = async (path, options = {}) => {
    const response = await fetch(origin + path, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
      ...options,
      headers: {
        cookie: [...cookies].map(([k, v]) => k + '=' + v).join('; '),
        'accept-encoding': 'identity',
        ...options.headers,
      },
    });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0],
        split = pair.indexOf('=');
      cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    assert(response.ok, path + ' returned ' + response.status);
    return response;
  };
  const csrf = await (await request('/api/auth/csrf')).json();
  await request('/api/auth/callback/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password, csrfToken: csrf.csrfToken, json: 'true' }),
  });
  const session = await (await request('/api/auth/session')).json();
  assert(session.user?.id, 'Benchmark login failed.');
  return request;
}
async function measure(action, iterations, concurrency) {
  for (let i = 0; i < 3; i++) await action();
  const latencies = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next++ < iterations) {
        const start = performance.now();
        await action();
        latencies.push(performance.now() - start);
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  assert.equal(latencies.length, iterations);
  assert(seconds > 0);
  return {
    samples: latencies.length,
    concurrency,
    rps: Number((latencies.length / seconds).toFixed(2)),
    p50Ms: Number(latencies[Math.floor(latencies.length * 0.5)].toFixed(2)),
    p95Ms: Number(
      latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))].toFixed(2),
    ),
  };
}
const results = {};
for (const [name, origin] of Object.entries(origins)) {
  const request = await client(origin);
  const html = await (await request('/')).text();
  const assets = [
    ...new Set(
      [...html.matchAll(/(?:src|href)="([^" ]+\.(?:js|css)(?:\?[^" ]*)?)"/g)]
        .map((m) => m[1])
        .filter((path) => path.startsWith('/')),
    ),
  ];
  assert(assets.length > 0, 'No JS/CSS assets found in the page.');
  const fullPage = async () => {
    await (await request('/')).arrayBuffer();
    await Promise.all(
      assets.map(async (path) => {
        await (await request(path)).arrayBuffer();
      }),
    );
  };
  const read = (path) => async () => {
    await (await request(path)).arrayBuffer();
  };
  results[name] = {
    origin,
    assetCount: assets.length,
    fullPage: await measure(fullPage, 10, 2),
    session: await measure(read('/api/auth/session'), 40, 4),
    health: await measure(read('/api/health'), 40, 4),
  };
}
console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      transport: 'Compose network, identity encoding, authenticated, response bodies fully read',
      results,
    },
    null,
    2,
  ),
);
