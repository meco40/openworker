import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

async function loadRoute() {
  return import('../../../app/api/config/route');
}

function makePutRequest(body: unknown): Request {
  return new Request('http://localhost/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeRawPutRequest(rawBody: string): Request {
  return new Request('http://localhost/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  });
}

describe('/api/config route', () => {
  let configPath = '';

  beforeEach(() => {
    configPath = path.join(
      process.cwd(),
      '.local',
      `gateway-config.${Date.now()}.${Math.random().toString(36).slice(2)}.json`,
    );
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    if (fs.existsSync(`${configPath}.bak`)) {
      fs.unlinkSync(`${configPath}.bak`);
    }
    process.env.OPENCLAW_CONFIG_PATH = configPath;
  });

  afterEach(() => {
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    if (fs.existsSync(`${configPath}.bak`)) {
      fs.unlinkSync(`${configPath}.bak`);
    }
    delete process.env.OPENCLAW_CONFIG_PATH;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns 401 when user context is unavailable', async () => {
    mockUserContext(null);
    const { GET } = await loadRoute();
    const response = await GET();
    const payload = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(401);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('Unauthorized');
  });

  it('returns default config with revision when no config file exists', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const { GET } = await loadRoute();

    const response = await GET();
    const payload = (await response.json()) as {
      ok: boolean;
      config: { gateway?: { port?: number } };
      source: string;
      displayPath: string;
      warnings?: Array<{ code: string; message: string }>;
      revision: string;
      path?: string;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.source).toBe('default');
    expect(payload.path).toBeUndefined();
    expect(path.isAbsolute(payload.displayPath)).toBe(false);
    expect(payload.warnings).toEqual([]);
    expect(payload.config.gateway?.port).toBe(8080);
    expect(typeof payload.revision).toBe('string');
    expect(payload.revision.length).toBeGreaterThanOrEqual(8);
  });

  it('loads legacy bind-only gateway config with migration warnings', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const { GET } = await loadRoute();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          gateway: {
            mode: 'local',
            auth: { mode: 'token', token: 'abc' },
            port: 18789,
            bind: 'loopback',
            tailscale: { mode: 'off', resetOnExit: false },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const response = await GET();
    const payload = (await response.json()) as {
      ok: boolean;
      config: { gateway?: { port?: number; host?: string; bind?: string } };
      warnings?: Array<{ code: string; message: string }>;
      revision: string;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.config.gateway?.host).toBe('127.0.0.1');
    expect(payload.config.gateway?.bind).toBe('loopback');
    expect(
      payload.warnings?.some((warning) => warning.code === 'gateway.host.derived_from_bind'),
    ).toBe(true);
    expect(typeof payload.revision).toBe('string');
  });

  it('recovers invalid optional ui values on load with warnings', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const { GET } = await loadRoute();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          gateway: { port: 9090, host: '127.0.0.1', logLevel: 'info' },
          ui: { timeFormat: '18h', density: 'dense' },
        },
        null,
        2,
      ),
      'utf8',
    );

    const response = await GET();
    const payload = (await response.json()) as {
      ok: boolean;
      config: { ui?: { timeFormat?: string; density?: string } };
      warnings?: Array<{ code: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.config.ui?.timeFormat).toBe('24h');
    expect(payload.config.ui?.density).toBe('comfortable');
    expect(
      payload.warnings?.some((warning) => warning.code === 'ui.timeFormat.defaulted_from_invalid'),
    ).toBe(true);
  });

  it('redacts sensitive tokens in GET payload', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const { GET } = await loadRoute();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          gateway: { port: 9090, host: '127.0.0.1', logLevel: 'info' },
          channels: { telegram: { enabled: true, token: 'REAL_TELEGRAM_TOKEN' } },
        },
        null,
        2,
      ),
      'utf8',
    );

    const response = await GET();
    const payload = (await response.json()) as {
      ok: boolean;
      config: { channels?: { telegram?: { token?: string } } };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.config.channels?.telegram?.token).toBe('__REDACTED__');
  });

  it('persists config updates via PUT and serves them via GET', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const { GET, PUT } = await loadRoute();

    const firstGet = await GET();
    const firstPayload = (await firstGet.json()) as { ok: boolean; revision: string };

    const nextConfig = {
      gateway: { port: 9090, host: '127.0.0.1', logLevel: 'debug' },
      provider: { primary: 'gemini-3.0', fallback: 'gemini-2.5', rotation: true },
      channels: {
        webchat: { enabled: true },
        telegram: { enabled: true, token: 'ENV_T_TOKEN' },
        slack: { enabled: false },
      },
      tools: {
        browser: { managed: true, headless: true },
        sandbox: { type: 'docker', enabled: false },
      },
    };

    const putResponse = await PUT(
      makePutRequest({ config: nextConfig, revision: firstPayload.revision }),
    );
    const putPayload = (await putResponse.json()) as { ok: boolean; revision: string };

    expect(putResponse.status).toBe(200);
    expect(putPayload.ok).toBe(true);
    expect(typeof putPayload.revision).toBe('string');
    expect(fs.existsSync(configPath)).toBe(true);

    const getResponse = await GET();
    const getPayload = (await getResponse.json()) as {
      ok: boolean;
      config: { gateway?: { port?: number } };
      source: string;
      displayPath: string;
      revision: string;
      warnings?: Array<{ code: string; message: string }>;
      path?: string;
    };

    expect(getResponse.status).toBe(200);
    expect(getPayload.ok).toBe(true);
    expect(getPayload.source).toBe('file');
    expect(getPayload.path).toBeUndefined();
    expect(path.isAbsolute(getPayload.displayPath)).toBe(false);
    expect(getPayload.warnings).toEqual([]);
    expect(getPayload.config.gateway?.port).toBe(9090);
    expect(getPayload.revision).toBe(putPayload.revision);
  });

  it('rejects invalid payloads for PUT', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const { GET, PUT } = await loadRoute();

    const getResponse = await GET();
    const getPayload = (await getResponse.json()) as { revision: string };

    const response = await PUT(
      makePutRequest({ config: 'invalid', revision: getPayload.revision }),
    );
    const payload = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('object');
  });

  it('rejects null request bodies for PUT', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const { PUT } = await loadRoute();

    const response = await PUT(makeRawPutRequest('null'));
    const payload = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(payload.error.toLowerCase()).toContain('invalid');
  });

  it('rejects stale and missing revisions with 409', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const { GET, PUT } = await loadRoute();

    const getResponse = await GET();
    const getPayload = (await getResponse.json()) as { revision: string };

    const missingRevisionResponse = await PUT(
      makePutRequest({ config: { gateway: { port: 8080, host: '127.0.0.1', logLevel: 'info' } } }),
    );
    expect(missingRevisionResponse.status).toBe(409);

    const staleRevisionResponse = await PUT(
      makePutRequest({
        config: { gateway: { port: 8081, host: '127.0.0.1', logLevel: 'info' } },
        revision: `${getPayload.revision}-stale`,
      }),
    );
    const stalePayload = (await staleRevisionResponse.json()) as {
      ok: boolean;
      code?: string;
      currentRevision?: string;
    };

    expect(staleRevisionResponse.status).toBe(409);
    expect(stalePayload.ok).toBe(false);
    expect(stalePayload.code).toBe('CONFIG_STALE_REVISION');
    expect(typeof stalePayload.currentRevision).toBe('string');
  });

  it('rejects invalid ui settings in payload', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const { GET, PUT } = await loadRoute();

    const getResponse = await GET();
    const getPayload = (await getResponse.json()) as { revision: string };

    const response = await PUT(
      makePutRequest({
        config: {
          gateway: { port: 9090, host: '127.0.0.1', logLevel: 'info' },
          ui: { timeFormat: '18h' },
        },
        revision: getPayload.revision,
      }),
    );
    const payload = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('ui.timeFormat');
  });

  it('sanitizes unexpected internal errors and avoids path leaks', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    vi.doMock('../../../src/server/config/gatewayConfig', async () => {
      const actual = await vi.importActual<object>('../../../src/server/config/gatewayConfig');
      return {
        ...actual,
        loadGatewayConfig: vi.fn().mockRejectedValue(new Error(`EACCES: ${configPath}`)),
      };
    });

    const { GET } = await loadRoute();
    const response = await GET();
    const payload = (await response.json()) as { ok: boolean; error: string; code?: string };

    expect(response.status).toBe(500);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('Unable to load config.');
    expect(payload.code).toBe('CONFIG_INTERNAL_ERROR');
    expect(payload.error).not.toContain(configPath);
  });
});
