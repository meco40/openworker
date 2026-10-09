import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';

// This probe uses real production auth, persistence and provider dispatch.
// Only the remote model response is a controlled local HTTP fixture.
const base = (process.env.RELEASE_SMOKE_BASE_URL || 'http://web:3000').replace(/\/$/, '');
const email = process.env.AUTH_DEFAULT_EMAIL;
const password = process.env.AUTH_DEFAULT_PASSWORD;
assert(email && password, 'Set the isolated first-admin credentials for this probe.');
const answer = 'release-production-ok';
let providerCalls = 0;
let embeddingCalls = 0;
const fixture = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/tags') {
    return res.end(JSON.stringify({ models: [{ name: 'release-fixture' }] }));
  }
  if (req.url === '/v1/embeddings') {
    embeddingCalls += 1;
    return res.end(JSON.stringify({ data: [{ embedding: Array(1536).fill(0.01) }] }));
  }
  if (req.url !== '/v1/chat/completions') {
    res.statusCode = 404;
    return res.end('{}');
  }
  providerCalls += 1;
  if (body.stream) {
    res.setHeader('content-type', 'text/event-stream');
    res.write(
      'data: ' +
        JSON.stringify({
          model: 'release-fixture',
          choices: [{ delta: { content: answer }, finish_reason: null }],
        }) +
        '\n\n',
    );
    return res.end('data: [DONE]\n\n');
  }
  res.end(
    JSON.stringify({
      model: 'release-fixture',
      choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
});
await new Promise((resolve) => fixture.listen(11434, '0.0.0.0', resolve));
const cookies = new Map();
async function request(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    redirect: 'manual',
    headers: { cookie: [...cookies].map(([k, v]) => k + '=' + v).join('; '), ...options.headers },
    signal: AbortSignal.timeout(60_000),
  });
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(';')[0];
    const split = pair.indexOf('=');
    cookies.set(pair.slice(0, split), pair.slice(split + 1));
  }
  return response;
}
async function json(path, body, method = 'POST') {
  const response = await request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  assert(response.ok && data.ok !== false, path + ': ' + JSON.stringify(data));
  return data;
}
let socket;
try {
  assert.equal((await fetch(base + '/api/personas')).status, 401);
  const csrf = await (await request('/api/auth/csrf')).json();
  const login = await request('/api/auth/callback/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrfToken: csrf.csrfToken,
      email,
      password,
      callbackUrl: base,
      json: 'true',
    }),
  });
  assert(login.status < 400);
  const session = await (await request('/api/auth/session')).json();
  assert(session.user?.id, 'Authenticated session is missing.');
  const persona = (
    await json('/api/personas', {
      name: 'Release Probe ' + Date.now(),
      emoji: '🤖',
      vibe: 'Isolated release verification',
      files: { 'SOUL.md': 'Answer the test message briefly.' },
    })
  ).persona;
  const account = (
    await json('/api/model-hub/accounts', {
      providerId: 'ollama',
      label: 'Release HTTP fixture',
      authMethod: 'none',
    })
  ).account;
  const pipeline = await json('/api/model-hub/pipeline', {
    action: 'add',
    profileId: 'p1',
    accountId: account.id,
    providerId: 'ollama',
    modelName: 'release-fixture',
    priority: 1,
  });
  await json('/api/model-hub/pipeline', {
    action: 'status',
    modelId: pipeline.model.id,
    status: 'active',
  });
  const embeddingPipeline = await json('/api/model-hub/pipeline', {
    action: 'add',
    profileId: 'p1-embeddings',
    accountId: account.id,
    providerId: 'ollama',
    modelName: 'release-fixture',
    priority: 1,
  });
  await json('/api/model-hub/pipeline', {
    action: 'status',
    modelId: embeddingPipeline.model.id,
    status: 'active',
  });
  const embedding = await json('/api/model-hub/gateway', {
    operation: 'embedContent',
    payload: { contents: ['Production memory probe'] },
  });
  assert.equal(embedding.embedding?.values?.length, 1536);
  assert(embeddingCalls > 0, 'Embedding dispatch never reached the configured provider.');
  const stored = await json('/api/memory', {
    fcName: 'core_memory_store',
    args: {
      personaId: persona.id,
      type: 'fact',
      content: 'release-memory-persisted',
      importance: 3,
    },
  });
  assert(stored.result?.data?.id, 'Canonical memory write did not return an id.');
  const memories = await (
    await request('/api/memory?personaId=' + encodeURIComponent(persona.id))
  ).json();
  assert(memories.nodes?.some((node) => node.content?.includes('release-memory-persisted')));
  const wsUrl = base.replace(/^http/, 'ws') + '/ws?protocol=v2';
  const cookie = [...cookies].map(([k, v]) => k + '=' + v).join('; ');
  for (const [headers, expected] of [
    [{}, 401],
    [{ cookie, origin: 'https://foreign.invalid' }, 403],
  ]) {
    const denied = new WebSocket(wsUrl, { headers });
    const code = await new Promise((resolve, reject) => {
      denied.once('unexpected-response', (_, response) => {
        response.resume();
        denied.terminate();
        resolve(response.statusCode);
      });
      denied.once('open', () => {
        denied.close();
        reject(new Error('Unexpected unauthorised WS upgrade'));
      });
      denied.on('error', () => {});
    });
    assert.equal(code, expected);
  }
  socket = new WebSocket(wsUrl, { headers: { cookie } });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let nextId = 1;
  const pending = new Map();
  socket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    const entry = pending.get(frame.id);
    if (!entry) return;
    if (frame.type === 'res' && !frame.ok) {
      clearTimeout(entry.timer);
      pending.delete(frame.id);
      return entry.reject(new Error(JSON.stringify(frame.error)));
    }
    if (entry.stream && frame.type === 'stream') {
      entry.text += frame.delta || '';
      if (frame.done) {
        clearTimeout(entry.timer);
        pending.delete(frame.id);
        entry.resolve(entry.text);
      }
    } else if (!entry.stream && frame.type === 'res') {
      clearTimeout(entry.timer);
      pending.delete(frame.id);
      entry.resolve(frame.payload);
    }
  });
  function rpc(method, params, stream = false) {
    const id = 'release-' + nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(method + ' timed out'));
      }, 60_000);
      pending.set(id, { resolve, reject, timer, stream, text: '' });
      socket.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }
  const reset = await rpc('sessions.reset', {
    title: 'Production release smoke',
    personaId: persona.id,
  });
  assert(reset.conversationId);
  const text = await rpc(
    'chat.stream',
    {
      conversationId: reset.conversationId,
      personaId: persona.id,
      content: 'Reply with release-production-ok.',
    },
    true,
  );
  assert(text.includes(answer), 'Missing provider answer: ' + text);
  assert(providerCalls > 0, 'Production dispatch never reached the local HTTP provider.');
  const history = await rpc('chat.history', { conversationId: reset.conversationId, limit: 20 });
  assert(
    history.some((message) => message.role === 'agent' && message.content?.includes(answer)),
    'Assistant answer was not persisted.',
  );
  assert.equal((await request('/api/health/scheduler')).status, 200);
  console.log(
    JSON.stringify({
      ok: true,
      anonymousApi: 401,
      anonymousWs: 401,
      foreignOrigin: 403,
      login: true,
      authenticatedWs: 101,
      providerCalls,
      embeddingCalls,
      canonicalMemory: true,
      chat: answer,
      persisted: true,
      scheduler: 200,
    }),
  );
} finally {
  socket?.terminate();
  await new Promise((resolve) => fixture.close(resolve));
}
