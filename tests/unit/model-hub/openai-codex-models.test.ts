import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function buildCodexAccessToken(accountId = 'acct_test'): string {
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
      },
    }),
  ).toString('base64url');
  return `header.${payload}.signature`;
}

describe('openai-codex model fetching', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns known codex model seeds even without remote model lookup', async () => {
    const { default: adapter } = await import('@/server/model-hub/Models/openai-codex/index');

    const models = await adapter.fetchModels?.({
      secret: 'token',
      provider: {
        id: 'openai-codex',
        name: 'OpenAI Codex',
        icon: 'OC',
        authMethods: ['oauth'],
        endpointType: 'openai-native',
        capabilities: ['chat'],
        defaultModels: ['gpt-5.3-codex', 'gpt-5.2-codex'],
      },
      account: {} as never,
    });

    const ids = (models ?? []).map((model) => model.id);
    expect(ids).toContain('gpt-5.3-codex');
    expect(ids).toContain('gpt-5.2-codex');
    expect(ids).toContain('gpt-5.2');
    expect(ids).toContain('gpt-5.1');
    expect(ids).toContain('gpt-5.1-codex-mini');
    expect(ids).toContain('gpt-5.1-codex-max');
  });

  it('keeps custom provider default models while adding codex seeds', async () => {
    const { default: adapter } = await import('@/server/model-hub/Models/openai-codex/index');

    const models = await adapter.fetchModels?.({
      secret: 'token',
      provider: {
        id: 'openai-codex',
        name: 'OpenAI Codex',
        icon: 'OC',
        authMethods: ['oauth'],
        endpointType: 'openai-native',
        capabilities: ['chat'],
        defaultModels: ['gpt-6-preview-codex'],
      },
      account: {} as never,
    });

    const ids = (models ?? []).map((model) => model.id);
    expect(ids).toContain('gpt-6-preview-codex');
    expect(ids).toContain('gpt-5.3-codex');
    expect(ids).toContain('gpt-5.1');
  });

  it('dispatches codex requests to chatgpt backend with codex headers', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async () => {
      const sse = [
        'data: {"type":"response.output_text.delta","delta":"hello"}',
        '',
        'data: {"type":"response.completed","response":{"status":"completed","model":"gpt-5.3-codex","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}',
        '',
      ].join('\n');
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { default: adapter } = await import('@/server/model-hub/Models/openai-codex/index');

    const result = await adapter.dispatchGateway?.(
      {
        secret: buildCodexAccessToken('acct_dispatch'),
        provider: {
          id: 'openai-codex',
          name: 'OpenAI Codex',
          icon: 'OC',
          authMethods: ['oauth'],
          endpointType: 'openai-native',
          capabilities: ['chat'],
          defaultModels: ['gpt-5.3-codex'],
        },
        account: {} as never,
      },
      {
        model: 'gpt-5.3-codex',
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0.7,
      },
    );

    expect(result?.ok).toBe(true);
    expect(result?.text).toContain('hello');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCallUrl = String(
      (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
    );
    expect(firstCallUrl).toContain('chatgpt.com/backend-api/codex/responses');
    const firstCallInit = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[1] as {
      headers?: Record<string, string>;
      body?: string;
    };
    expect(firstCallInit?.headers?.['chatgpt-account-id']).toBe('acct_dispatch');
    expect(firstCallInit?.headers?.['OpenAI-Beta']).toBe('responses=experimental');
    const firstCallBody = JSON.parse(firstCallInit?.body || '{}') as {
      instructions?: string;
      temperature?: unknown;
    };
    expect(typeof firstCallBody.instructions).toBe('string');
    expect(firstCallBody.instructions?.length).toBeGreaterThan(0);
    expect(firstCallBody.temperature).toBeUndefined();

    global.fetch = originalFetch;
  });

  it('preserves whitespace across codex output_text deltas', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async () => {
      const sse = [
        'data: {"type":"response.output_text.delta","delta":"Ich"}',
        '',
        'data: {"type":"response.output_text.delta","delta":" bin"}',
        '',
        'data: {"type":"response.output_text.delta","delta":" ein Modell"}',
        '',
        'data: {"type":"response.completed","response":{"status":"completed","model":"gpt-5.3-codex"}}',
        '',
      ].join('\n');
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { default: adapter } = await import('@/server/model-hub/Models/openai-codex/index');

    const result = await adapter.dispatchGateway?.(
      {
        secret: buildCodexAccessToken('acct_dispatch'),
        provider: {
          id: 'openai-codex',
          name: 'OpenAI Codex',
          icon: 'OC',
          authMethods: ['oauth'],
          endpointType: 'openai-native',
          capabilities: ['chat'],
          defaultModels: ['gpt-5.3-codex'],
        },
        account: {} as never,
      },
      {
        model: 'gpt-5.3-codex',
        messages: [{ role: 'user', content: 'ping' }],
      },
    );

    expect(result?.ok).toBe(true);
    expect(result?.text).toBe('Ich bin ein Modell');

    global.fetch = originalFetch;
  });

  it('sends image attachments as input_image content for codex responses', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async () => {
      const sse = [
        'data: {"type":"response.output_text.delta","delta":"gesehen"}',
        '',
        'data: {"type":"response.completed","response":{"status":"completed","model":"gpt-5.3-codex"}}',
        '',
      ].join('\n');
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-vision-'));
    const imagePath = path.join(tmpDir, 'pixel.png');
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9N5R8AAAAASUVORK5CYII=',
      'base64',
    );
    fs.writeFileSync(imagePath, pngBytes);

    const { default: adapter } = await import('@/server/model-hub/Models/openai-codex/index');

    await adapter.dispatchGateway?.(
      {
        secret: buildCodexAccessToken('acct_dispatch'),
        provider: {
          id: 'openai-codex',
          name: 'OpenAI Codex',
          icon: 'OC',
          authMethods: ['oauth'],
          endpointType: 'openai-native',
          capabilities: ['chat', 'vision'],
          defaultModels: ['gpt-5.3-codex'],
        },
        account: {} as never,
      },
      {
        model: 'gpt-5.3-codex',
        messages: [
          {
            role: 'user',
            content: 'Was siehst du?',
            attachments: [
              {
                name: 'pixel.png',
                mimeType: 'image/png',
                size: pngBytes.length,
                storagePath: imagePath,
              },
            ],
          },
        ],
      },
    );

    const firstCallInit = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[1] as {
      body?: string;
    };
    const firstCallBody = JSON.parse(firstCallInit?.body || '{}') as {
      input?: Array<{ role?: string; content?: Array<{ type?: string; image_url?: string }> }>;
    };
    const userInput = firstCallBody.input?.[0];
    expect(userInput?.role).toBe('user');
    expect(
      userInput?.content?.some(
        (part) =>
          part.type === 'input_image' &&
          String(part.image_url || '').startsWith('data:image/png;base64,'),
      ),
    ).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    global.fetch = originalFetch;
  });
});
