import type { GatewayConfig } from '../../config/gatewayConfig';
import { loadGatewayConfig, saveGatewayConfig } from '../../config/gatewayConfig';

export type OpenAiWorkerToolId = 'shell' | 'browser' | 'files' | 'github' | 'mcp' | 'computerUse';

interface ToolCatalogEntry {
  id: OpenAiWorkerToolId;
  name: string;
  description: string;
  functionName: string;
  configKey: string;
  defaultEnabled: boolean;
}

export interface OpenAiWorkerToolState {
  id: OpenAiWorkerToolId;
  name: string;
  description: string;
  functionName: string;
  enabled: boolean;
}

const OPENAI_WORKER_TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  {
    id: 'shell',
    name: 'Shell',
    description: 'Run controlled shell commands in the worker environment.',
    functionName: 'safe_shell',
    configKey: 'shell',
    defaultEnabled: false,
  },
  {
    id: 'browser',
    name: 'Browser',
    description: 'Navigate pages and capture browser snapshots.',
    functionName: 'safe_browser',
    configKey: 'browser',
    defaultEnabled: false,
  },
  {
    id: 'files',
    name: 'Files',
    description: 'Read and write files inside allowed workspace paths.',
    functionName: 'safe_files',
    configKey: 'files',
    defaultEnabled: false,
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Query repositories and issue metadata through the GitHub tool.',
    functionName: 'safe_github',
    configKey: 'github',
    defaultEnabled: false,
  },
  {
    id: 'mcp',
    name: 'MCP',
    description: 'Call configured MCP servers through a guarded proxy tool.',
    functionName: 'safe_mcp',
    configKey: 'mcp',
    defaultEnabled: false,
  },
  {
    id: 'computerUse',
    name: 'Computer Use',
    description: 'Control remote browser/computer actions with approval boundaries.',
    functionName: 'safe_computer_use',
    configKey: 'computerUse',
    defaultEnabled: false,
  },
] as const;

const TOOL_BY_ID = new Map(OPENAI_WORKER_TOOL_CATALOG.map((tool) => [tool.id, tool]));

function getNestedObject(root: unknown, key: string): Record<string, unknown> {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return {};
  const value = (root as Record<string, unknown>)[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function getEnabledFromConfig(config: GatewayConfig, entry: ToolCatalogEntry): boolean {
  const worker = getNestedObject(config, 'worker');
  const openai = getNestedObject(worker, 'openai');
  const tools = getNestedObject(openai, 'tools');
  const toolConfig = getNestedObject(tools, entry.configKey);
  const enabledValue = (toolConfig as { enabled?: unknown }).enabled;
  return typeof enabledValue === 'boolean' ? enabledValue : entry.defaultEnabled;
}

function toToolState(config: GatewayConfig, entry: ToolCatalogEntry): OpenAiWorkerToolState {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    functionName: entry.functionName,
    enabled: getEnabledFromConfig(config, entry),
  };
}

function ensureMutableObject(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = root[key];
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  root[key] = created;
  return created;
}

function applyToolToggle(config: GatewayConfig, entry: ToolCatalogEntry, enabled: boolean): GatewayConfig {
  const nextConfig = JSON.parse(JSON.stringify(config)) as GatewayConfig;
  const root = nextConfig as Record<string, unknown>;
  const worker = ensureMutableObject(root, 'worker');
  const openai = ensureMutableObject(worker, 'openai');
  const tools = ensureMutableObject(openai, 'tools');
  const tool = ensureMutableObject(tools, entry.configKey);
  tool.enabled = enabled;
  return nextConfig;
}

export async function listOpenAiWorkerTools(): Promise<OpenAiWorkerToolState[]> {
  const state = await loadGatewayConfig();
  return OPENAI_WORKER_TOOL_CATALOG.map((entry) => toToolState(state.config, entry));
}

export async function setOpenAiWorkerToolEnabled(
  id: string,
  enabled: boolean,
): Promise<OpenAiWorkerToolState> {
  const tool = TOOL_BY_ID.get(id as OpenAiWorkerToolId);
  if (!tool) {
    throw new Error(`Unknown OpenAI worker tool: ${id}`);
  }

  const current = await loadGatewayConfig();
  const nextConfig = applyToolToggle(current.config, tool, enabled);
  const saved = await saveGatewayConfig(nextConfig, { expectedRevision: current.revision });
  return toToolState(saved.config, tool);
}

export function resolveEnabledOpenAiWorkerToolNamesFromConfig(config: GatewayConfig): string[] {
  return OPENAI_WORKER_TOOL_CATALOG.filter((entry) => getEnabledFromConfig(config, entry)).map(
    (entry) => entry.functionName,
  );
}

export async function listEnabledOpenAiWorkerToolNames(): Promise<string[]> {
  const state = await loadGatewayConfig();
  return resolveEnabledOpenAiWorkerToolNamesFromConfig(state.config);
}
