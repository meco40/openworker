#!/usr/bin/env node
/**
 * Records the Gemini HTTP traffic of the current TypeScript adapter as
 * fixtures for the Rust port (Slice S4).
 *
 * The recorder patches the global `fetch` before the adapter — and the
 * `@google/genai` SDK it uses — is imported, drives every adapter code path
 * against canned, API-shaped responses and writes the recorded exchanges
 * (request method, URL, contract headers, JSON body plus the response) to
 * `rust/crates/betaclaw-gateway/tests/fixtures/gemini/exchanges.json`.
 *
 * The request side is the oracle: `@google/genai` serialises `contents`,
 * `systemInstruction`, `tools` and the API-key header in its own way (the
 * same class of foreign detail as the compact `jose@4` JWE format). The
 * canned responses pin what the Rust client must be able to parse.
 *
 * The script asserts the adapter-level outputs and the URL/header contract,
 * so an SDK upgrade that silently changes the wire format fails loudly here
 * instead of drifting into the fixture.
 *
 *   pnpm run fixtures:gemini-traffic
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const FIXTURE_PATH = join(
  REPO_ROOT,
  'rust',
  'crates',
  'betaclaw-gateway',
  'tests',
  'fixtures',
  'gemini',
  'exchanges.json',
);
const API_ORIGIN = 'https://generativelanguage.googleapis.com';
const SECRET = 'parity-not-a-real-key';

function fail(message) {
  console.error(`FIXTURE-FEHLER: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

/** Headers that are part of the wire contract; everything else is volatile. */
const CONTRACT_HEADERS = new Set(['content-type', 'x-goog-api-key']);

const recorded = [];

/** Reads header pairs from either a plain object or a `Headers` instance. */
function headerPairs(headers) {
  if (!headers) return [];
  if (typeof headers.entries === 'function') return [...headers.entries()];
  return Object.entries(headers);
}

/** Redacts the API key from URLs and headers so the fixture holds no secrets. */
function redactExchange(scenario, url, init, response) {
  const headers = {};
  for (const [name, value] of headerPairs(init.headers)) {
    const lower = name.toLowerCase();
    if (!CONTRACT_HEADERS.has(lower)) continue;
    headers[lower] = lower === 'x-goog-api-key' ? '[REDACTED]' : value;
  }

  let body = null;
  if (typeof init.body === 'string') {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }

  return {
    scenario,
    request: {
      method: init.method ?? 'GET',
      url: url.replace(`key=${encodeURIComponent(SECRET)}`, 'key=[REDACTED]'),
      headers,
      body,
    },
    response,
  };
}

/** Sequential canned responses; the adapter is driven one call at a time. */
const queue = [];

globalThis.fetch = async function recordedFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const step = queue.shift();
  assert(step, `unerwarteter HTTP-Aufruf: ${url}`);
  assert(step.expect(url), `Aufruf passt nicht zu Szenario '${step.name}': ${url}`);

  recorded.push(redactExchange(step.name, url, init, step.respond));
  return new Response(JSON.stringify(step.respond.body), {
    status: step.respond.status,
    headers: { 'Content-Type': 'application/json' },
  });
};

function enqueueGenerateContent(name, body) {
  queue.push({
    name,
    expect: (url) => url === `${API_ORIGIN}/v1beta/models/gemini-2.5-flash:generateContent`,
    respond: { status: 200, body },
  });
}

function enqueueModels(name, status, body) {
  queue.push({
    name,
    expect: (url) => url.startsWith(`${API_ORIGIN}/v1beta/models?`),
    respond: { status, body },
  });
}

const MODELS_OK = {
  models: [
    {
      name: 'models/gemini-2.5-flash',
      displayName: 'Gemini 2.5 Flash',
      inputTokenLimit: 1048576,
    },
    {
      name: 'models/gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      inputTokenLimit: 1048576,
    },
    { name: 'models/embedding-001', displayName: 'Embedding 001' },
  ],
};

const PONG = {
  candidates: [{ content: { parts: [{ text: 'pong' }], role: 'model' }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
  modelVersion: 'gemini-2.5-flash',
};

const WEATHER_CALL = {
  candidates: [
    {
      content: {
        parts: [{ functionCall: { name: 'get_weather', args: { city: 'Berlin' } } }],
        role: 'model',
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 5, totalTokenCount: 14 },
};

const MODELS_UNAUTHENTICATED = {
  error: {
    code: 401,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'UNAUTHENTICATED',
  },
};

const WEATHER_TOOL = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Current weather for a city',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name' },
        },
        required: ['city'],
      },
    },
  },
];

async function driveAdapter() {
  const { default: gemini } = await import('../../src/server/model-hub/Models/gemini/index.ts');

  // 1. fetchModels — success, filters away the non-gemini entry.
  enqueueModels('fetchModels ok', 200, MODELS_OK);
  const models = await gemini.fetchModels({ secret: SECRET });
  assert(
    JSON.stringify(models) ===
      JSON.stringify([
        {
          id: 'gemini-2.5-flash',
          name: 'Gemini 2.5 Flash',
          provider: 'gemini',
          context_window: 1048576,
        },
        {
          id: 'gemini-2.5-pro',
          name: 'Gemini 2.5 Pro',
          provider: 'gemini',
          context_window: 1048576,
        },
      ]),
    `fetchModels liefert unerwartete Modelle: ${JSON.stringify(models)}`,
  );

  // 2. fetchModels — non-ok answers with an empty list, not an error.
  enqueueModels('fetchModels 401', 401, MODELS_UNAUTHENTICATED);
  const empty = await gemini.fetchModels({ secret: SECRET });
  assert(empty.length === 0, `fetchModels bei 401 muss leer sein, war ${JSON.stringify(empty)}`);

  // 3. testConnectivity — minimal ping through the SDK.
  enqueueGenerateContent('testConnectivity ping', PONG);
  const ping = await gemini.testConnectivity({
    provider: { defaultModels: ['gemini-2.5-flash'] },
    secret: SECRET,
  });
  assert(
    ping.ok === true && ping.message === 'Gemini connectivity verified.',
    `testConnectivity unerwartet: ${JSON.stringify(ping)}`,
  );

  // 4. dispatchGateway — text answer with system instruction and usage mapping.
  enqueueGenerateContent('dispatchGateway text', PONG);
  const textResult = await gemini.dispatchGateway(
    { secret: SECRET },
    {
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'system', content: 'You are a test.' },
        { role: 'user', content: 'Say pong' },
      ],
      max_tokens: 64,
      temperature: 0.5,
    },
    {},
  );
  assert(
    textResult.ok === true &&
      textResult.text === 'pong' &&
      textResult.model === 'gemini-2.5-flash' &&
      textResult.provider === 'gemini',
    `dispatchGateway Text unerwartet: ${JSON.stringify(textResult)}`,
  );
  assert(
    JSON.stringify(textResult.usage) ===
      JSON.stringify({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }),
    `Usage-Mapping unerwartet: ${JSON.stringify(textResult.usage)}`,
  );

  // 5. dispatchGateway — tool declaration is normalised to Gemini's shape and
  // a function call comes back.
  enqueueGenerateContent('dispatchGateway function call', WEATHER_CALL);
  const toolResult = await gemini.dispatchGateway(
    { secret: SECRET },
    {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Wetter in Berlin?' }],
      tools: WEATHER_TOOL,
    },
    {},
  );
  assert(
    toolResult.ok === true &&
      JSON.stringify(toolResult.functionCalls) ===
        JSON.stringify([{ name: 'get_weather', args: { city: 'Berlin' } }]),
    `dispatchGateway Function-Call unerwartet: ${JSON.stringify(toolResult)}`,
  );
  assert(textResult.functionCalls === undefined, 'Textantwort darf keine functionCalls tragen');
}

function assertWireContract() {
  const models = recorded.filter((exchange) => exchange.scenario.startsWith('fetchModels'));
  assert(models.length === 2, 'zwei fetchModels-Aufrufe erwartet');
  for (const exchange of models) {
    assert(
      exchange.request.url === `${API_ORIGIN}/v1beta/models?key=[REDACTED]&pageSize=100`,
      `fetchModels-URL weicht ab: ${exchange.request.url}`,
    );
    assert(exchange.request.method === 'GET', 'fetchModels ist ein GET');
  }

  const generate = recorded.filter((exchange) => exchange.scenario.startsWith('dispatchGateway'));
  assert(generate.length === 2, 'zwei dispatchGateway-Aufrufe erwartet');
  const textExchange = generate[0];
  assert(
    textExchange.request.headers['content-type'] === 'application/json',
    'generateContent sendet Content-Type application/json',
  );
  assert(
    textExchange.request.headers['x-goog-api-key'] === '[REDACTED]',
    'generateContent authentifiziert über x-goog-api-key',
  );
  // The SDK serialises the system instruction as a Content object, not a
  // plain string, and nests generation parameters into `generationConfig`.
  // Both are SDK quirks the Rust port must reproduce.
  assert(
    JSON.stringify(textExchange.request.body.systemInstruction) ===
      JSON.stringify({ parts: [{ text: 'You are a test.' }], role: 'user' }),
    `systemInstruction-Serialisierung unerwartet: ${JSON.stringify(textExchange.request.body.systemInstruction)}`,
  );
  assert(
    JSON.stringify(textExchange.request.body.contents) ===
      JSON.stringify([{ parts: [{ text: 'Say pong' }], role: 'user' }]),
    `contents-Rollenmapping unerwartet: ${JSON.stringify(textExchange.request.body.contents)}`,
  );
  assert(
    JSON.stringify(textExchange.request.body.generationConfig) ===
      JSON.stringify({ temperature: 0.5, maxOutputTokens: 64 }),
    `generationConfig unerwartet: ${JSON.stringify(textExchange.request.body.generationConfig)}`,
  );
  assert(
    textExchange.request.body.maxOutputTokens === undefined &&
      textExchange.request.body.temperature === undefined,
    'Config-Felder gehören in generationConfig, nicht auf Top-Level-Niveau',
  );

  const toolBody = generate[1].request.body;
  assert(
    JSON.stringify(toolBody.tools) ===
      JSON.stringify([
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Current weather for a city',
              parameters: {
                type: 'OBJECT',
                properties: {
                  city: { type: 'STRING', description: 'City name' },
                },
                required: ['city'],
              },
            },
          ],
        },
      ]),
    `Tool-Normalisierung unerwartet: ${JSON.stringify(toolBody.tools)}`,
  );

  const ping = recorded.find((exchange) => exchange.scenario === 'testConnectivity ping');
  assert(ping, 'testConnectivity-Aufruf fehlt in der Aufzeichnung');
  // The adapter passes `contents: 'Ping'` as a plain string; the SDK
  // normalises it to the usual Content shape.
  assert(
    JSON.stringify(ping.request.body.contents) ===
      JSON.stringify([{ parts: [{ text: 'Ping' }], role: 'user' }]),
    `testConnectivity contents unerwartet: ${JSON.stringify(ping.request.body.contents)}`,
  );
}

async function main() {
  await driveAdapter();
  assert(queue.length === 0, `${queue.length} erwartete Aufrufe blieben aus`);

  const expectedScenarios = [
    'fetchModels ok',
    'fetchModels 401',
    'testConnectivity ping',
    'dispatchGateway text',
    'dispatchGateway function call',
  ];
  assert(
    JSON.stringify(recorded.map((exchange) => exchange.scenario)) ===
      JSON.stringify(expectedScenarios),
    `Szenario-Reihenfolge unerwartet: ${JSON.stringify(recorded.map((exchange) => exchange.scenario))}`,
  );

  assertWireContract();

  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, `${JSON.stringify({ exchanges: recorded }, null, 2)}\n`, 'utf8');
  console.log(`${recorded.length} Gemini-Exchanges aufgezeichnet → ${FIXTURE_PATH}`);
}

await main();
