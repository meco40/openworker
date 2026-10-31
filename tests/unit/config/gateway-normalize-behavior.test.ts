import { describe, expect, it } from 'vitest';
import { normalizeGatewayConfig } from '@/server/config/gateway/normalize';

function configWith(overrides: Record<string, unknown> = {}) {
  return {
    gateway: {
      port: 8080,
      host: '127.0.0.1',
      bind: 'loopback',
      logLevel: 'info',
      ...(overrides.gateway as Record<string, unknown> | undefined),
    },
    provider: overrides.provider ?? {
      primary: 'gemini-2.5',
      fallback: 'gemini-2.0',
      rotation: true,
    },
    channels: overrides.channels ?? {
      webchat: { enabled: true },
      telegram: { enabled: false, token: 'telegram-token' },
      slack: { enabled: false },
    },
    tools: overrides.tools ?? {
      browser: { managed: true, headless: true },
      sandbox: { type: 'docker', enabled: false },
    },
    ...(overrides.ui === undefined ? {} : { ui: overrides.ui }),
  };
}

describe('normalizeGatewayConfig behavior', () => {
  it('defaults missing host, bind, and log level while accepting omitted optional sections', () => {
    const result = normalizeGatewayConfig(
      configWith({
        gateway: {
          port: 8080,
          host: undefined,
          bind: undefined,
          logLevel: undefined,
          auth: { mode: 'none' },
          tailscale: { mode: 'off' },
        },
        provider: { primary: 'gemini' },
        channels: {},
        tools: {},
      }),
      'load',
    );

    expect(result.config.gateway).toMatchObject({
      host: '127.0.0.1',
      bind: 'loopback',
      logLevel: 'info',
    });
    expect(result.warnings.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['gateway.host_bind.defaulted', 'gateway.logLevel.defaulted']),
    );
    expect(result.config.provider).toMatchObject({ primary: 'gemini' });
  });

  it('derives supported host and bind pairs from either legacy field', () => {
    const bindAll = normalizeGatewayConfig(
      configWith({ gateway: { port: 8080, host: undefined, bind: 'all', logLevel: 'info' } }),
      'load',
    );
    const hostAll = normalizeGatewayConfig(
      configWith({
        gateway: { port: 8080, host: '0.0.0.0', bind: undefined, logLevel: 'info' },
      }),
      'load',
    );
    const customHost = normalizeGatewayConfig(
      configWith({
        gateway: { port: 8080, host: '192.0.2.15', bind: undefined, logLevel: 'info' },
      }),
      'load',
    );
    const customBind = normalizeGatewayConfig(
      configWith({ gateway: { port: 8080, host: undefined, bind: 'lan', logLevel: 'info' } }),
      'load',
    );

    expect(bindAll.config.gateway).toMatchObject({ host: '0.0.0.0', bind: 'all' });
    expect(hostAll.config.gateway).toMatchObject({ host: '0.0.0.0', bind: 'all' });
    expect(customHost.config.gateway).toMatchObject({ host: '192.0.2.15', bind: '192.0.2.15' });
    expect(customBind.config.gateway).toMatchObject({ host: 'lan', bind: 'lan' });
  });

  it('repairs malformed optional UI settings on load and reports each warning', () => {
    const result = normalizeGatewayConfig(
      configWith({
        ui: {
          defaultView: 5,
          density: 5,
          language: '   ',
          timeFormat: 12,
          showAdvancedDebug: 'yes',
        },
      }),
      'load',
    );

    expect(result.config.ui).toMatchObject({
      defaultView: 'dashboard',
      density: 'comfortable',
      language: 'de-DE',
      timeFormat: '24h',
      showAdvancedDebug: false,
    });
    expect(result.warnings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'ui.defaultView.defaulted_from_invalid',
        'ui.density.defaulted_from_invalid',
        'ui.language.defaulted_from_invalid',
        'ui.timeFormat.defaulted_from_invalid',
        'ui.showAdvancedDebug.defaulted_from_invalid',
      ]),
    );

    const blankView = normalizeGatewayConfig(configWith({ ui: { defaultView: '  ' } }), 'load');
    expect(blankView.config.ui).toMatchObject({ defaultView: 'dashboard' });
    const unsupportedView = normalizeGatewayConfig(
      configWith({ ui: { defaultView: 'worker' } }),
      'load',
    );
    expect(unsupportedView.config.ui).toMatchObject({ defaultView: 'dashboard' });
  });

  it.each([
    ['ui.defaultView', { defaultView: '  ' }],
    ['ui.density', { density: 'dense' }],
    ['ui.language', { language: '' }],
    ['ui.timeFormat', { timeFormat: '18h' }],
    ['ui.showAdvancedDebug', { showAdvancedDebug: 'yes' }],
  ])('rejects invalid %s when saving', (field, ui) => {
    expect(() => normalizeGatewayConfig(configWith({ ui }), 'save')).toThrow(field);
  });

  it('rejects malformed types and values at gateway, provider, channel, and tool boundaries', () => {
    const invalidConfigs: Array<[string, Record<string, unknown>]> = [
      ['gateway.port', configWith({ gateway: { port: 0 } })],
      ['gateway.port', configWith({ gateway: { port: 65536 } })],
      ['gateway.logLevel', configWith({ gateway: { logLevel: 'trace' } })],
      ['provider.primary', configWith({ provider: { primary: ' ' } })],
      ['provider.fallback', configWith({ provider: { primary: 'valid', fallback: 42 } })],
      ['provider.rotation', configWith({ provider: { primary: 'valid', rotation: 'yes' } })],
      ['channels.webchat.enabled', configWith({ channels: { webchat: { enabled: 'yes' } } })],
      [
        'channels.telegram.token',
        configWith({ channels: { telegram: { enabled: true, token: ' ' } } }),
      ],
      [
        'tools.browser.headless',
        configWith({ tools: { browser: { managed: true, headless: 1 } } }),
      ],
      ['tools.sandbox.type', configWith({ tools: { sandbox: { type: '', enabled: true } } })],
      [
        'gateway.tailscale.resetOnExit',
        configWith({ gateway: { tailscale: { mode: 'off', resetOnExit: 'no' } } }),
      ],
    ];

    for (const [field, config] of invalidConfigs) {
      expect(() => normalizeGatewayConfig(config, 'save')).toThrow(field);
    }
  });

  it('rejects arrays or primitives where configuration objects are required', () => {
    const invalidObjects: Array<[string, unknown]> = [
      ['config', []],
      ['gateway', { gateway: [] }],
      ['provider', configWith({ provider: [] })],
      ['channels', configWith({ channels: 'invalid' })],
      ['tools', configWith({ tools: [] })],
      ['ui', configWith({ ui: [] })],
      ['gateway.auth', configWith({ gateway: { auth: [] } })],
      ['gateway.tailscale', configWith({ gateway: { tailscale: [] } })],
      ['channels.webchat', configWith({ channels: { webchat: [] } })],
      ['channels.telegram', configWith({ channels: { telegram: [] } })],
      ['channels.slack', configWith({ channels: { slack: [] } })],
      ['tools.browser', configWith({ tools: { browser: [] } })],
      ['tools.sandbox', configWith({ tools: { sandbox: [] } })],
    ];

    for (const [label, config] of invalidObjects) {
      expect(() => normalizeGatewayConfig(config, 'save')).toThrow(`${label} must be an object`);
    }
  });
});
