import path from 'node:path';
import { WORKSPACE_ROOT } from './constants';

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

export function resolveGatewayConfigPath(): string {
  const configuredPath = process.env.OPENCLAW_CONFIG_PATH;
  if (typeof configuredPath === 'string' && configuredPath.trim().length > 0) {
    const trimmedPath = configuredPath.trim();
    const normalized = trimmedPath.replace(/\\/g, '/');

    if (path.isAbsolute(trimmedPath)) return trimmedPath;
    if (normalized.startsWith('.local/') || normalized.startsWith('.openclaw/')) {
      return path.resolve(WORKSPACE_ROOT, normalized);
    }
    return path.resolve(WORKSPACE_ROOT, '.local', normalized);
  }

  const homeDir = resolveHomeDirFromEnv();
  if (homeDir) return path.join(homeDir, '.openclaw', 'openclaw.json');
  return path.resolve(WORKSPACE_ROOT, '.local', 'openclaw.json');
}

export function resolveGatewayConfigBackend(): 'db' | 'file' {
  const raw = String(process.env.OPENCLAW_CONFIG_BACKEND || 'db')
    .trim()
    .toLowerCase();
  return raw === 'file' ? 'file' : 'db';
}

export function resolveGatewayConfigDbPath(): string {
  const configuredPath = String(process.env.GATEWAY_CONFIG_DB_PATH || '').trim();
  if (configuredPath) {
    if (path.isAbsolute(configuredPath)) return configuredPath;
    return path.resolve(WORKSPACE_ROOT, configuredPath);
  }
  return path.resolve('.local/gateway-config.db');
}

