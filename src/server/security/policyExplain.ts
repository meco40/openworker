import { loadGatewayConfig } from '../config/gatewayConfig';

export interface EffectivePolicyExplainSnapshot {
  generatedAt: string;
  revision: string;
  source: string;
  runtime: {
    mode: 'main-chat-only';
    workerRemoved: true;
  };
  channels: {
    webchatEnabled: boolean;
    telegramEnabled: boolean;
    slackEnabled: boolean;
  };
  tools: {
    browserManaged: boolean;
    browserHeadless: boolean;
    sandboxEnabled: boolean;
    sandboxType: string | null;
  };
}

function getNestedObject(root: unknown, key: string): Record<string, unknown> {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return {};
  const value = (root as Record<string, unknown>)[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function getBoolean(root: unknown, key: string, fallback = false): boolean {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return fallback;
  const value = (root as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : fallback;
}

function getString(root: unknown, key: string): string | null {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  const value = (root as Record<string, unknown>)[key];
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export async function buildEffectivePolicyExplainSnapshot(): Promise<EffectivePolicyExplainSnapshot> {
  const state = await loadGatewayConfig();
  const config = state.config;
  const channels = getNestedObject(config, 'channels');
  const tools = getNestedObject(config, 'tools');
  const webchat = getNestedObject(channels, 'webchat');
  const telegram = getNestedObject(channels, 'telegram');
  const slack = getNestedObject(channels, 'slack');
  const browser = getNestedObject(tools, 'browser');
  const sandbox = getNestedObject(tools, 'sandbox');

  return {
    generatedAt: new Date().toISOString(),
    revision: state.revision,
    source: state.source,
    runtime: {
      mode: 'main-chat-only',
      workerRemoved: true,
    },
    channels: {
      webchatEnabled: getBoolean(webchat, 'enabled'),
      telegramEnabled: getBoolean(telegram, 'enabled'),
      slackEnabled: getBoolean(slack, 'enabled'),
    },
    tools: {
      browserManaged: getBoolean(browser, 'managed'),
      browserHeadless: getBoolean(browser, 'headless'),
      sandboxEnabled: getBoolean(sandbox, 'enabled'),
      sandboxType: getString(sandbox, 'type'),
    },
  };
}
