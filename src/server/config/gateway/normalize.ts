import {
  ALLOWED_UI_DEFAULT_VIEWS,
  isAllowedUiDefaultView,
  isAllowedUiDensity,
  isAllowedUiTimeFormat,
} from '@/shared/config/uiSchema';
import { DEFAULT_GATEWAY_CONFIG } from './constants';
import {
  type GatewayConfig,
  type GatewayConfigWarning,
  GatewayConfigValidationError,
  type JsonObject,
  type NormalizeMode,
} from './types';

export function cloneObject<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneDefaultConfig(): GatewayConfig {
  return cloneObject(DEFAULT_GATEWAY_CONFIG);
}

function ensureObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GatewayConfigValidationError(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function ensureString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayConfigValidationError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function ensureOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return ensureString(value, label);
}

function ensureBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new GatewayConfigValidationError(`${label} must be a boolean.`);
  }
  return value;
}

function ensureIntInRange(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new GatewayConfigValidationError(
      `${label} must be an integer between ${min} and ${max}.`,
    );
  }
  return value;
}

function normalizeHostFromBind(bind: string): string {
  if (bind === 'loopback') return '127.0.0.1';
  if (bind === 'all') return '0.0.0.0';
  return bind;
}

function normalizeBindFromHost(host: string): string {
  if (host === '127.0.0.1' || host === 'localhost') return 'loopback';
  if (host === '0.0.0.0') return 'all';
  return host;
}

function withWarning(warnings: GatewayConfigWarning[], code: string, message: string): void {
  warnings.push({ code, message });
}

function normalizeUiConfig(
  root: JsonObject,
  mode: NormalizeMode,
  warnings: GatewayConfigWarning[],
): void {
  if (root.ui === undefined) return;
  const ui = ensureObject(root.ui, 'ui');

  if (ui.defaultView !== undefined) {
    const rawDefaultView = typeof ui.defaultView === 'string' ? ui.defaultView.trim() : '';
    if (!rawDefaultView) {
      if (mode === 'save') throw new GatewayConfigValidationError('ui.defaultView must be a non-empty string.');
      ui.defaultView = 'dashboard';
      withWarning(warnings, 'ui.defaultView.defaulted_from_invalid', 'ui.defaultView was invalid. Defaulted to dashboard.');
    } else if (!isAllowedUiDefaultView(rawDefaultView)) {
      if (mode === 'save') {
        throw new GatewayConfigValidationError(
          `ui.defaultView must be one of: ${ALLOWED_UI_DEFAULT_VIEWS.join(', ')}.`,
        );
      }
      ui.defaultView = 'dashboard';
      withWarning(
        warnings,
        'ui.defaultView.defaulted_from_invalid',
        `ui.defaultView (${rawDefaultView}) is unsupported. Defaulted to dashboard.`,
      );
    } else {
      ui.defaultView = rawDefaultView;
    }
  }

  if (ui.density !== undefined) {
    const density = typeof ui.density === 'string' ? ui.density.trim() : '';
    if (!density || !isAllowedUiDensity(density)) {
      if (mode === 'save') throw new GatewayConfigValidationError('ui.density must be one of: comfortable, compact.');
      ui.density = 'comfortable';
      withWarning(
        warnings,
        'ui.density.defaulted_from_invalid',
        'ui.density was invalid. Defaulted to comfortable.',
      );
    } else {
      ui.density = density;
    }
  }

  if (ui.language !== undefined) {
    if (typeof ui.language !== 'string' || ui.language.trim().length === 0) {
      if (mode === 'save') throw new GatewayConfigValidationError('ui.language must be a non-empty string.');
      ui.language = 'de-DE';
      withWarning(warnings, 'ui.language.defaulted_from_invalid', 'ui.language was invalid. Defaulted to de-DE.');
    } else {
      ui.language = ui.language.trim();
    }
  }

  if (ui.timeFormat !== undefined) {
    const timeFormat = typeof ui.timeFormat === 'string' ? ui.timeFormat.trim() : '';
    if (!timeFormat || !isAllowedUiTimeFormat(timeFormat)) {
      if (mode === 'save') throw new GatewayConfigValidationError('ui.timeFormat must be one of: 12h, 24h.');
      ui.timeFormat = '24h';
      withWarning(warnings, 'ui.timeFormat.defaulted_from_invalid', 'ui.timeFormat was invalid. Defaulted to 24h.');
    } else {
      ui.timeFormat = timeFormat;
    }
  }

  if (ui.showAdvancedDebug !== undefined && typeof ui.showAdvancedDebug !== 'boolean') {
    if (mode === 'save') throw new GatewayConfigValidationError('ui.showAdvancedDebug must be a boolean.');
    ui.showAdvancedDebug = false;
    withWarning(
      warnings,
      'ui.showAdvancedDebug.defaulted_from_invalid',
      'ui.showAdvancedDebug was invalid. Defaulted to false.',
    );
  }
}

export function normalizeGatewayConfig(
  rawConfig: unknown,
  mode: NormalizeMode,
): { config: GatewayConfig; warnings: GatewayConfigWarning[] } {
  const warnings: GatewayConfigWarning[] = [];
  const root = ensureObject(cloneObject(rawConfig), 'config');
  const gateway = ensureObject(root.gateway, 'gateway');
  ensureIntInRange(gateway.port, 'gateway.port', 1, 65535);

  let host =
    typeof gateway.host === 'string' && gateway.host.trim().length > 0
      ? gateway.host.trim()
      : undefined;
  let bind =
    typeof gateway.bind === 'string' && gateway.bind.trim().length > 0
      ? gateway.bind.trim()
      : undefined;

  if (host && !bind) {
    bind = normalizeBindFromHost(host);
    withWarning(warnings, 'gateway.bind.derived_from_host', `gateway.bind was missing. Derived from gateway.host (${host}) => ${bind}.`);
  }
  if (!host && bind) {
    host = normalizeHostFromBind(bind);
    withWarning(warnings, 'gateway.host.derived_from_bind', `gateway.host was missing. Derived from gateway.bind (${bind}) => ${host}.`);
  }
  if (!host && !bind) {
    host = '127.0.0.1';
    bind = 'loopback';
    withWarning(
      warnings,
      'gateway.host_bind.defaulted',
      'gateway.host and gateway.bind were missing. Defaulted to 127.0.0.1/loopback.',
    );
  }
  gateway.host = host;
  gateway.bind = bind;

  const logLevelRaw = gateway.logLevel;
  const logLevel =
    typeof logLevelRaw === 'string' && logLevelRaw.trim().length > 0 ? logLevelRaw.trim() : 'info';
  if (logLevelRaw === undefined) {
    withWarning(warnings, 'gateway.logLevel.defaulted', 'gateway.logLevel was missing. Defaulted to info.');
  }
  if (!new Set(['debug', 'info', 'warn', 'error']).has(logLevel)) {
    throw new GatewayConfigValidationError(
      'gateway.logLevel must be one of: debug, info, warn, error.',
    );
  }
  gateway.logLevel = logLevel;

  if (root.provider !== undefined) {
    const provider = ensureObject(root.provider, 'provider');
    ensureString(provider.primary, 'provider.primary');
    ensureOptionalString(provider.fallback, 'provider.fallback');
    if (provider.rotation !== undefined) ensureBoolean(provider.rotation, 'provider.rotation');
  }

  if (root.channels !== undefined) {
    const channels = ensureObject(root.channels, 'channels');
    if (channels.webchat !== undefined) ensureBoolean(ensureObject(channels.webchat, 'channels.webchat').enabled, 'channels.webchat.enabled');
    if (channels.telegram !== undefined) {
      const telegram = ensureObject(channels.telegram, 'channels.telegram');
      ensureBoolean(telegram.enabled, 'channels.telegram.enabled');
      ensureOptionalString(telegram.token, 'channels.telegram.token');
    }
    if (channels.slack !== undefined) ensureBoolean(ensureObject(channels.slack, 'channels.slack').enabled, 'channels.slack.enabled');
  }

  if (root.tools !== undefined) {
    const tools = ensureObject(root.tools, 'tools');
    if (tools.browser !== undefined) {
      const browser = ensureObject(tools.browser, 'tools.browser');
      ensureBoolean(browser.managed, 'tools.browser.managed');
      ensureBoolean(browser.headless, 'tools.browser.headless');
    }
    if (tools.sandbox !== undefined) {
      const sandbox = ensureObject(tools.sandbox, 'tools.sandbox');
      ensureString(sandbox.type, 'tools.sandbox.type');
      ensureBoolean(sandbox.enabled, 'tools.sandbox.enabled');
    }
  }

  normalizeUiConfig(root, mode, warnings);

  if (gateway.auth !== undefined) {
    const auth = ensureObject(gateway.auth, 'gateway.auth');
    ensureString(auth.mode, 'gateway.auth.mode');
    ensureOptionalString(auth.token, 'gateway.auth.token');
  }
  if (gateway.tailscale !== undefined) {
    const tailscale = ensureObject(gateway.tailscale, 'gateway.tailscale');
    ensureString(tailscale.mode, 'gateway.tailscale.mode');
    if (tailscale.resetOnExit !== undefined) ensureBoolean(tailscale.resetOnExit, 'gateway.tailscale.resetOnExit');
  }

  return { config: root as GatewayConfig, warnings };
}

