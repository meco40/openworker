import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GatewayConfig } from './types';

export const REDACTED_SECRET_VALUE = '__REDACTED__';
export const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../',
);
export const GATEWAY_CONFIG_DB_ROW_ID = 1;
export const GATEWAY_CONFIG_DB_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS gateway_config_state (
    id INTEGER PRIMARY KEY,
    config_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

export const SECRET_PATHS = [
  ['channels', 'telegram', 'token'],
  ['gateway', 'auth', 'token'],
] as const;

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
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
