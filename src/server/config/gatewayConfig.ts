import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import {
  ALLOWED_UI_DEFAULT_VIEWS,
  isAllowedUiDefaultView,
  isAllowedUiDensity,
  isAllowedUiTimeFormat,
} from '@/shared/config/uiSchema';

export type GatewayConfig = Record<string, unknown>;
export type GatewayConfigSource = 'default' | 'file' | 'db';

export interface GatewayConfigWarning {
  code: string;
  message: string;
}

export interface GatewayConfigState {
  config: GatewayConfig;
  source: GatewayConfigSource;
  path: string;
  warnings: GatewayConfigWarning[];
  revision: string;
}

export class GatewayConfigValidationError extends Error {}

export class GatewayConfigConflictError extends Error {
  readonly currentRevision: string;

  constructor(message: string, currentRevision: string) {
    super(message);
    this.currentRevision = currentRevision;
  }
}

type JsonObject = Record<string, unknown>;
type NormalizeMode = 'load' | 'save';

const REDACTED_SECRET_VALUE = '__REDACTED__';
const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const GATEWAY_CONFIG_DB_ROW_ID = 1;
const GATEWAY_CONFIG_DB_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS gateway_config_state (
    id INTEGER PRIMARY KEY,
    config_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const SECRET_PATHS = [
  ['channels', 'telegram', 'token'],
  ['gateway', 'auth', 'token'],
] as const;

const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  gateway: {
    port: 8080,
    host: '0.0.0.0',
    bind: 'all',
    logLevel: 'info',
  },
  provider: {
    primary: 'gemini-3-flash-preview',
    fallback: 'gemini-3-pro-preview',
    rotation: true,
  },
  channels: {
    webchat: { enabled: true },
    telegram: { enabled: true, token: 'ENV_T_TOKEN' },
    slack: { enabled: false },
  },
  tools: {
    browser: { managed: true, headless: true },
    sandbox: { type: 'docker', enabled: false },
  },
  ui: {
    defaultView: 'dashboard',
    density: 'comfortable',
    language: 'de-DE',
    timeFormat: '24h',
    showAdvancedDebug: false,
  },
};

function cloneObject<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneDefaultConfig(): GatewayConfig {
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
  if (root.ui === undefined) {
    return;
  }

  const ui = ensureObject(root.ui, 'ui');

  if (ui.defaultView !== undefined) {
    const rawDefaultView = typeof ui.defaultView === 'string' ? ui.defaultView.trim() : '';
    if (!rawDefaultView) {
      if (mode === 'save') {
        throw new GatewayConfigValidationError('ui.defaultView must be a non-empty string.');
      }
      ui.defaultView = 'dashboard';
      withWarning(
        warnings,
        'ui.defaultView.defaulted_from_invalid',
        'ui.defaultView was invalid. Defaulted to dashboard.',
      );
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
      if (mode === 'save') {
        throw new GatewayConfigValidationError('ui.density must be one of: comfortable, compact.');
      }
      ui.density = 'comfortable';
      withWarning(
        warnings,
        'ui.density.defaulted_from_invalid',
        `ui.density was invalid. Defaulted to comfortable.`,
      );
    } else {
      ui.density = density;
    }
  }

  if (ui.language !== undefined) {
    if (typeof ui.language !== 'string' || ui.language.trim().length === 0) {
      if (mode === 'save') {
        throw new GatewayConfigValidationError('ui.language must be a non-empty string.');
      }
      ui.language = 'de-DE';
      withWarning(
        warnings,
        'ui.language.defaulted_from_invalid',
        'ui.language was invalid. Defaulted to de-DE.',
      );
    } else {
      ui.language = ui.language.trim();
    }
  }

  if (ui.timeFormat !== undefined) {
    const timeFormat = typeof ui.timeFormat === 'string' ? ui.timeFormat.trim() : '';
    if (!timeFormat || !isAllowedUiTimeFormat(timeFormat)) {
      if (mode === 'save') {
        throw new GatewayConfigValidationError('ui.timeFormat must be one of: 12h, 24h.');
      }
      ui.timeFormat = '24h';
      withWarning(
        warnings,
        'ui.timeFormat.defaulted_from_invalid',
        `ui.timeFormat was invalid. Defaulted to 24h.`,
      );
    } else {
      ui.timeFormat = timeFormat;
    }
  }

  if (ui.showAdvancedDebug !== undefined && typeof ui.showAdvancedDebug !== 'boolean') {
    if (mode === 'save') {
      throw new GatewayConfigValidationError('ui.showAdvancedDebug must be a boolean.');
    }
    ui.showAdvancedDebug = false;
    withWarning(
      warnings,
      'ui.showAdvancedDebug.defaulted_from_invalid',
      'ui.showAdvancedDebug was invalid. Defaulted to false.',
    );
  }
}

function normalizeGatewayConfig(
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
    withWarning(
      warnings,
      'gateway.bind.derived_from_host',
      `gateway.bind was missing. Derived from gateway.host (${host}) => ${bind}.`,
    );
  }

  if (!host && bind) {
    host = normalizeHostFromBind(bind);
    withWarning(
      warnings,
      'gateway.host.derived_from_bind',
      `gateway.host was missing. Derived from gateway.bind (${bind}) => ${host}.`,
    );
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
    withWarning(
      warnings,
      'gateway.logLevel.defaulted',
      'gateway.logLevel was missing. Defaulted to info.',
    );
  }
  const allowedLogLevels = new Set(['debug', 'info', 'warn', 'error']);
  if (!allowedLogLevels.has(logLevel)) {
    throw new GatewayConfigValidationError(
      'gateway.logLevel must be one of: debug, info, warn, error.',
    );
  }
  gateway.logLevel = logLevel;

  if (root.provider !== undefined) {
    const provider = ensureObject(root.provider, 'provider');
    ensureString(provider.primary, 'provider.primary');
    ensureOptionalString(provider.fallback, 'provider.fallback');
    if (provider.rotation !== undefined) {
      ensureBoolean(provider.rotation, 'provider.rotation');
    }
  }

  if (root.channels !== undefined) {
    const channels = ensureObject(root.channels, 'channels');

    if (channels.webchat !== undefined) {
      const webchat = ensureObject(channels.webchat, 'channels.webchat');
      ensureBoolean(webchat.enabled, 'channels.webchat.enabled');
    }
    if (channels.telegram !== undefined) {
      const telegram = ensureObject(channels.telegram, 'channels.telegram');
      ensureBoolean(telegram.enabled, 'channels.telegram.enabled');
      ensureOptionalString(telegram.token, 'channels.telegram.token');
    }
    if (channels.slack !== undefined) {
      const slack = ensureObject(channels.slack, 'channels.slack');
      ensureBoolean(slack.enabled, 'channels.slack.enabled');
    }
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
    if (tailscale.resetOnExit !== undefined) {
      ensureBoolean(tailscale.resetOnExit, 'gateway.tailscale.resetOnExit');
    }
  }

  return { config: root as GatewayConfig, warnings };
}

function normalizeDisplayPath(rawPath: string): string {
  return rawPath.split(path.sep).join('/');
}

function resolveHomeDirFromEnv(): string {
  const home = String(process.env.HOME || process.env.USERPROFILE || '').trim();
  return home ? path.resolve(home) : '';
}

export function toGatewayConfigDisplayPath(configPath: string): string {
  const absolutePath = path.resolve(configPath);
  const homeDir = resolveHomeDirFromEnv();

  if (homeDir) {
    const homeRelative = path.relative(homeDir, absolutePath);
    if (
      homeRelative.length > 0 &&
      !homeRelative.startsWith('..') &&
      !path.isAbsolute(homeRelative)
    ) {
      return `~/${normalizeDisplayPath(homeRelative)}`;
    }
  }

  const cwdRelative = path.relative(process.cwd(), absolutePath);
  if (cwdRelative.length > 0 && !cwdRelative.startsWith('..') && !path.isAbsolute(cwdRelative)) {
    return `./${normalizeDisplayPath(cwdRelative)}`;
  }

  return `.../${path.basename(absolutePath)}`;
}

function resolveGatewayConfigPath(): string {
  const configuredPath = process.env.OPENCLAW_CONFIG_PATH;
  if (typeof configuredPath === 'string' && configuredPath.trim().length > 0) {
    const trimmedPath = configuredPath.trim();
    const normalized = trimmedPath.replace(/\\/g, '/');

    if (path.isAbsolute(trimmedPath)) {
      return trimmedPath;
    }

    if (normalized.startsWith('.local/') || normalized.startsWith('.openclaw/')) {
      return path.resolve(WORKSPACE_ROOT, normalized);
    }

    return path.resolve(WORKSPACE_ROOT, '.local', normalized);
  }

  const homeDir = resolveHomeDirFromEnv();
  if (homeDir) {
    return path.join(homeDir, '.openclaw', 'openclaw.json');
  }
  return path.resolve(WORKSPACE_ROOT, '.local', 'openclaw.json');
}

function resolveGatewayConfigBackend(): 'db' | 'file' {
  const raw = String(process.env.OPENCLAW_CONFIG_BACKEND || 'db')
    .trim()
    .toLowerCase();
  return raw === 'file' ? 'file' : 'db';
}

function resolveGatewayConfigDbPath(): string {
  const configuredPath = String(process.env.GATEWAY_CONFIG_DB_PATH || '').trim();
  if (configuredPath) {
    if (path.isAbsolute(configuredPath)) return configuredPath;
    return path.resolve(WORKSPACE_ROOT, configuredPath);
  }
  return path.resolve('.local/gateway-config.db');
}

function computeGatewayConfigRevision(config: GatewayConfig): string {
  const normalized = JSON.stringify(config);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function getPathValue(root: unknown, segments: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const segment of segments) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as JsonObject)[segment];
  }
  return cursor;
}

function setPathValue(root: unknown, segments: readonly string[], value: unknown): void {
  let cursor = root as JsonObject;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const current = cursor[segment];
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as JsonObject;
  }
  cursor[segments[segments.length - 1]] = value;
}

export function redactGatewayConfigSecrets(config: GatewayConfig): GatewayConfig {
  const redacted = cloneObject(config);
  for (const pathSegments of SECRET_PATHS) {
    const value = getPathValue(redacted, pathSegments);
    if (typeof value === 'string' && value.trim().length > 0) {
      setPathValue(redacted, pathSegments, REDACTED_SECRET_VALUE);
    }
  }
  return redacted;
}

function restoreRedactedSecrets(nextConfig: unknown, currentConfig: GatewayConfig): unknown {
  const restored = cloneObject(nextConfig);
  for (const pathSegments of SECRET_PATHS) {
    const nextValue = getPathValue(restored, pathSegments);
    if (nextValue !== REDACTED_SECRET_VALUE) {
      continue;
    }
    const currentValue = getPathValue(currentConfig, pathSegments);
    if (typeof currentValue === 'string' && currentValue.trim().length > 0) {
      setPathValue(restored, pathSegments, currentValue);
    }
  }
  return restored;
}

export async function loadGatewayConfig(): Promise<GatewayConfigState> {
  if (resolveGatewayConfigBackend() === 'db') {
    const dbPath = resolveGatewayConfigDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new BetterSqlite3(dbPath);
    try {
      db.exec(GATEWAY_CONFIG_DB_TABLE_SQL);
      const row = db
        .prepare('SELECT config_json FROM gateway_config_state WHERE id = ?')
        .get(GATEWAY_CONFIG_DB_ROW_ID) as { config_json?: string } | undefined;

      if (!row?.config_json) {
        const normalized = normalizeGatewayConfig(cloneDefaultConfig(), 'load');
        return {
          config: normalized.config,
          source: 'default',
          path: dbPath,
          warnings: [],
          revision: computeGatewayConfigRevision(normalized.config),
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(row.config_json);
      } catch {
        throw new GatewayConfigValidationError('Gateway config row contains invalid JSON.');
      }

      const normalized = normalizeGatewayConfig(parsed, 'load');
      return {
        config: normalized.config,
        source: 'db',
        path: dbPath,
        warnings: normalized.warnings,
        revision: computeGatewayConfigRevision(normalized.config),
      };
    } finally {
      db.close();
    }
  }

  const configPath = resolveGatewayConfigPath();

  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeGatewayConfig(parsed, 'load');
    return {
      config: normalized.config,
      source: 'file',
      path: configPath,
      warnings: normalized.warnings,
      revision: computeGatewayConfigRevision(normalized.config),
    };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      const normalized = normalizeGatewayConfig(cloneDefaultConfig(), 'load');
      return {
        config: normalized.config,
        source: 'default',
        path: configPath,
        warnings: [],
        revision: computeGatewayConfigRevision(normalized.config),
      };
    }

    if (error instanceof SyntaxError) {
      throw new GatewayConfigValidationError('Gateway config file contains invalid JSON.');
    }

    throw error;
  }
}

async function createBackupIfPresent(configPath: string): Promise<void> {
  try {
    const currentRaw = await readFile(configPath, 'utf8');
    await writeFile(`${configPath}.bak`, currentRaw, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      return;
    }
    throw error;
  }
}

export async function saveGatewayConfig(
  input: unknown,
  options?: { expectedRevision?: string },
): Promise<{
  config: GatewayConfig;
  path: string;
  source: GatewayConfigSource;
  warnings: GatewayConfigWarning[];
  revision: string;
}> {
  if (resolveGatewayConfigBackend() === 'db') {
    const dbPath = resolveGatewayConfigDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new BetterSqlite3(dbPath);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(GATEWAY_CONFIG_DB_TABLE_SQL);

      const row = db
        .prepare('SELECT config_json FROM gateway_config_state WHERE id = ?')
        .get(GATEWAY_CONFIG_DB_ROW_ID) as { config_json?: string } | undefined;

      const currentNormalized = (() => {
        if (!row?.config_json) return normalizeGatewayConfig(cloneDefaultConfig(), 'load');
        const parsed = JSON.parse(row.config_json) as unknown;
        return normalizeGatewayConfig(parsed, 'load');
      })();
      const currentRevision = computeGatewayConfigRevision(currentNormalized.config);

      const expectedRevision = String(options?.expectedRevision || '').trim();
      if (!expectedRevision || expectedRevision !== currentRevision) {
        throw new GatewayConfigConflictError(
          'Config was changed by another session. Reload and review your changes.',
          currentRevision,
        );
      }

      const restoredInput = restoreRedactedSecrets(input, currentNormalized.config);
      const normalized = normalizeGatewayConfig(restoredInput, 'save');
      const config = normalized.config;
      const revision = computeGatewayConfigRevision(config);

      db.prepare(
        `
          INSERT INTO gateway_config_state (id, config_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            config_json = excluded.config_json,
            updated_at = excluded.updated_at
        `,
      ).run(GATEWAY_CONFIG_DB_ROW_ID, JSON.stringify(config), new Date().toISOString());

      return {
        config,
        path: dbPath,
        source: 'db',
        warnings: normalized.warnings,
        revision,
      };
    } finally {
      db.close();
    }
  }

  const current = await loadGatewayConfig();
  const expectedRevision = String(options?.expectedRevision || '').trim();
  if (!expectedRevision || expectedRevision !== current.revision) {
    throw new GatewayConfigConflictError(
      'Config was changed by another session. Reload and review your changes.',
      current.revision,
    );
  }

  const restoredInput = restoreRedactedSecrets(input, current.config);
  const normalized = normalizeGatewayConfig(restoredInput, 'save');
  const config = normalized.config;
  const configPath = resolveGatewayConfigPath();
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

  await mkdir(path.dirname(configPath), { recursive: true });
  await createBackupIfPresent(configPath);
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  try {
    await rename(tempPath, configPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  return {
    config,
    path: configPath,
    source: 'file',
    warnings: normalized.warnings,
    revision: computeGatewayConfigRevision(config),
  };
}
