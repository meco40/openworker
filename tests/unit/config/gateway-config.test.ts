import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('node:fs/promises', () => fsMock);

function validConfig() {
  return {
    gateway: {
      port: 8080,
      host: '127.0.0.1',
      logLevel: 'info',
    },
    provider: {
      primary: 'gemini-3.0',
      fallback: 'gemini-2.5',
      rotation: true,
    },
    channels: {
      webchat: { enabled: true },
      telegram: { enabled: false, token: 'ENV_T_TOKEN' },
      slack: { enabled: false },
    },
    tools: {
      browser: { managed: true, headless: true },
      sandbox: { type: 'docker', enabled: false },
    },
  };
}

describe('gatewayConfig service', () => {
  let configPath = '';

  beforeEach(() => {
    configPath = path.join(
      process.cwd(),
      '.local',
      `gateway-config.unit.${Date.now()}.${Math.random().toString(36).slice(2)}.json`,
    );
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    if (fs.existsSync(`${configPath}.bak`)) {
      fs.unlinkSync(`${configPath}.bak`);
    }
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_CONFIG_BACKEND = 'file';

    fsMock.mkdir.mockReset();
    fsMock.readFile.mockReset();
    fsMock.writeFile.mockReset();
    fsMock.rename.mockReset();
    fsMock.rm.mockReset();

    fsMock.mkdir.mockImplementation(async () => {});
    fsMock.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    fsMock.writeFile.mockImplementation(async () => {});
    fsMock.rename.mockImplementation(async () => {});
    fsMock.rm.mockImplementation(async () => {});
  });

  afterEach(() => {
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    if (fs.existsSync(`${configPath}.bak`)) {
      fs.unlinkSync(`${configPath}.bak`);
    }
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_CONFIG_BACKEND;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('rejects schema-invalid gateway.port', async () => {
    const { loadGatewayConfig, saveGatewayConfig } = await import('@/server/config/gateway/gatewayConfig');
    const broken = validConfig();
    (broken.gateway as { port: unknown }).port = '8080';

    const loaded = await loadGatewayConfig();
    await expect(saveGatewayConfig(broken, { expectedRevision: loaded.revision })).rejects.toThrow(
      'gateway.port',
    );
  });

  it('normalizes legacy bind-only config on load and emits warnings', async () => {
    fsMock.readFile.mockResolvedValueOnce(
      JSON.stringify({
        gateway: {
          mode: 'local',
          auth: { mode: 'token', token: 'abc' },
          port: 18789,
          bind: 'loopback',
          tailscale: { mode: 'off', resetOnExit: false },
        },
      }),
    );

    const { loadGatewayConfig } = await import('@/server/config/gateway/gatewayConfig');
    const loaded = await loadGatewayConfig();
    const gateway = loaded.config.gateway as { host?: string; bind?: string };

    expect(gateway.host).toBe('127.0.0.1');
    expect(gateway.bind).toBe('loopback');
    expect(
      loaded.warnings.some((warning) => warning.code === 'gateway.host.derived_from_bind'),
    ).toBe(true);
  });

  it('normalizes legacy bind-only config on save and emits warnings', async () => {
    const { loadGatewayConfig, saveGatewayConfig } = await import('@/server/config/gateway/gatewayConfig');
    const loaded = await loadGatewayConfig();

    const saved = await saveGatewayConfig(
      {
        gateway: {
          mode: 'local',
          auth: { mode: 'token', token: 'abc' },
          port: 18789,
          bind: 'loopback',
          tailscale: { mode: 'off', resetOnExit: false },
        },
      },
      { expectedRevision: loaded.revision },
    );
    const gateway = saved.config.gateway as { host?: string; bind?: string };

    expect(gateway.host).toBe('127.0.0.1');
    expect(gateway.bind).toBe('loopback');
    expect(
      saved.warnings.some((warning) => warning.code === 'gateway.host.derived_from_bind'),
    ).toBe(true);
  });

  it('recovers invalid optional ui values on load', async () => {
    fsMock.readFile.mockResolvedValueOnce(
      JSON.stringify({
        gateway: { port: 8080, host: '127.0.0.1', logLevel: 'info' },
        ui: { timeFormat: '18h', density: 'dense' },
      }),
    );

    const { loadGatewayConfig } = await import('@/server/config/gateway/gatewayConfig');
    const loaded = await loadGatewayConfig();
    const ui = loaded.config.ui as { density?: string; timeFormat?: string };

    expect(ui.density).toBe('comfortable');
    expect(ui.timeFormat).toBe('24h');
    expect(
      loaded.warnings.some((warning) => warning.code === 'ui.timeFormat.defaulted_from_invalid'),
    ).toBe(true);
  });

  it('accepts valid ui settings', async () => {
    const { loadGatewayConfig, saveGatewayConfig } = await import('@/server/config/gateway/gatewayConfig');
    const loaded = await loadGatewayConfig();

    const saved = await saveGatewayConfig(
      {
        ...validConfig(),
        ui: {
          defaultView: 'dashboard',
          density: 'compact',
          language: 'de-DE',
          timeFormat: '24h',
          showAdvancedDebug: false,
        },
      },
      { expectedRevision: loaded.revision },
    );

    const ui = saved.config.ui as { density?: string; timeFormat?: string };
    expect(ui.density).toBe('compact');
    expect(ui.timeFormat).toBe('24h');
  });

  it('rejects invalid ui.timeFormat on save', async () => {
    const { loadGatewayConfig, saveGatewayConfig } = await import('@/server/config/gateway/gatewayConfig');
    const loaded = await loadGatewayConfig();

    await expect(
      saveGatewayConfig(
        {
          ...validConfig(),
          ui: {
            timeFormat: '18h',
          },
        },
        { expectedRevision: loaded.revision },
      ),
    ).rejects.toThrow('ui.timeFormat');
  });

  it('rejects invalid ui.defaultView on save', async () => {
    const { loadGatewayConfig, saveGatewayConfig } = await import('@/server/config/gateway/gatewayConfig');
    const loaded = await loadGatewayConfig();

    await expect(
      saveGatewayConfig(
        {
          ...validConfig(),
          ui: {
            defaultView: 'worker',
          },
        },
        { expectedRevision: loaded.revision },
      ),
    ).rejects.toThrow('ui.defaultView');
  });

  it('writes atomically via temporary file and rename', async () => {
    const { loadGatewayConfig, saveGatewayConfig } = await import('@/server/config/gateway/gatewayConfig');
    const loaded = await loadGatewayConfig();

    await saveGatewayConfig(validConfig(), { expectedRevision: loaded.revision });

    expect(fsMock.rename).toHaveBeenCalledTimes(1);
    expect(fsMock.writeFile).toHaveBeenCalled();

    const latestWriteArgs = fsMock.writeFile.mock.calls.find((args) =>
      String(args[0]).includes('.tmp'),
    );
    const writtenPath = latestWriteArgs?.[0];
    expect(typeof writtenPath).toBe('string');
    expect(String(writtenPath)).toContain('.tmp');
    expect(fsMock.rename).toHaveBeenCalledWith(String(writtenPath), configPath);
  });

  it('creates backup snapshot when current config file exists', async () => {
    const currentConfigRaw = JSON.stringify({
      gateway: { port: 8080, host: '127.0.0.1', logLevel: 'info' },
      channels: { telegram: { enabled: true, token: 'REAL_TOKEN' } },
    });
    let configReadCount = 0;
    fsMock.readFile.mockImplementation(async (targetPath: string) => {
      if (targetPath !== configPath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      configReadCount += 1;
      if (configReadCount <= 2) {
        return currentConfigRaw;
      }
      return 'existing-raw-json';
    });

    const { loadGatewayConfig, saveGatewayConfig } = await import('@/server/config/gateway/gatewayConfig');
    const loaded = await loadGatewayConfig();

    await saveGatewayConfig(validConfig(), { expectedRevision: loaded.revision });

    const backupWrite = fsMock.writeFile.mock.calls.find((args) =>
      String(args[0]).endsWith('.bak'),
    );
    expect(backupWrite).toBeDefined();
    expect(String(backupWrite?.[0])).toBe(`${configPath}.bak`);
  });

  it('restores masked secrets from current config on save', async () => {
    const currentConfigRaw = JSON.stringify({
      gateway: { port: 8080, host: '127.0.0.1', logLevel: 'info' },
      channels: { telegram: { enabled: true, token: 'REAL_TOKEN' } },
    });
    fsMock.readFile.mockImplementation(async (targetPath: string) => {
      if (targetPath !== configPath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return currentConfigRaw;
    });

    const { loadGatewayConfig, saveGatewayConfig } = await import('@/server/config/gateway/gatewayConfig');
    const loaded = await loadGatewayConfig();
    const saved = await saveGatewayConfig(
      {
        gateway: { port: 8080, host: '127.0.0.1', logLevel: 'info' },
        channels: { telegram: { enabled: true, token: '__REDACTED__' } },
      },
      { expectedRevision: loaded.revision },
    );

    const telegram = (saved.config.channels as { telegram?: { token?: string } }).telegram;
    expect(telegram?.token).toBe('REAL_TOKEN');
  });
});

