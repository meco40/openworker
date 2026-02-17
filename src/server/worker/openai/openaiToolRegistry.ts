import type { GatewayConfig } from '../../config/gatewayConfig';
import { loadGatewayConfig, saveGatewayConfig } from '../../config/gatewayConfig';

export type OpenAiWorkerToolId =
  | 'shell'
  | 'browser'
  | 'browserUse'
  | 'files'
  | 'github'
  | 'mcp'
  | 'computerUse';

export type OpenAiWorkerToolApprovalMode = 'deny' | 'ask_approve' | 'approve_always';

export interface OpenAiWorkerToolApprovalPolicy {
  defaultMode: OpenAiWorkerToolApprovalMode;
  byFunctionName: Record<string, OpenAiWorkerToolApprovalMode>;
}

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
  approvalMode: OpenAiWorkerToolApprovalMode;
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
    id: 'browserUse',
    name: 'Browser Use',
    description: 'Run autonomous browser tasks via browser-use.',
    functionName: 'safe_browser_use',
    configKey: 'browserUse',
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
const BROWSER_USE_PRIMARY_FUNCTION = 'safe_browser_use';
const LEGACY_BROWSER_FUNCTIONS = new Set(['safe_browser', 'safe_computer_use']);
const DEFAULT_APPROVAL_MODE: OpenAiWorkerToolApprovalMode = 'ask_approve';
const APPROVAL_MODES = new Set<OpenAiWorkerToolApprovalMode>([
  'deny',
  'ask_approve',
  'approve_always',
]);

function isApprovalMode(value: unknown): value is OpenAiWorkerToolApprovalMode {
  return typeof value === 'string' && APPROVAL_MODES.has(value as OpenAiWorkerToolApprovalMode);
}

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

function getDefaultApprovalModeFromConfig(config: GatewayConfig): OpenAiWorkerToolApprovalMode {
  const worker = getNestedObject(config, 'worker');
  const openai = getNestedObject(worker, 'openai');
  const security = getNestedObject(openai, 'security');
  const defaultApprovalMode = (security as { defaultApprovalMode?: unknown }).defaultApprovalMode;
  return isApprovalMode(defaultApprovalMode) ? defaultApprovalMode : DEFAULT_APPROVAL_MODE;
}

function getApprovalModeFromConfig(
  config: GatewayConfig,
  entry: ToolCatalogEntry,
): OpenAiWorkerToolApprovalMode {
  const worker = getNestedObject(config, 'worker');
  const openai = getNestedObject(worker, 'openai');
  const security = getNestedObject(openai, 'security');
  const tools = getNestedObject(security, 'tools');
  const toolPolicy = getNestedObject(tools, entry.configKey);
  const approvalMode = (toolPolicy as { approvalMode?: unknown }).approvalMode;
  if (isApprovalMode(approvalMode)) return approvalMode;
  return getDefaultApprovalModeFromConfig(config);
}

function toToolState(config: GatewayConfig, entry: ToolCatalogEntry): OpenAiWorkerToolState {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    functionName: entry.functionName,
    enabled: getEnabledFromConfig(config, entry),
    approvalMode: getApprovalModeFromConfig(config, entry),
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

function applyToolToggle(
  config: GatewayConfig,
  entry: ToolCatalogEntry,
  enabled: boolean,
): GatewayConfig {
  const nextConfig = JSON.parse(JSON.stringify(config)) as GatewayConfig;
  const root = nextConfig as Record<string, unknown>;
  const worker = ensureMutableObject(root, 'worker');
  const openai = ensureMutableObject(worker, 'openai');
  const tools = ensureMutableObject(openai, 'tools');
  const tool = ensureMutableObject(tools, entry.configKey);
  tool.enabled = enabled;
  return nextConfig;
}

function applyToolApprovalMode(
  config: GatewayConfig,
  entry: ToolCatalogEntry,
  approvalMode: OpenAiWorkerToolApprovalMode,
): GatewayConfig {
  const nextConfig = JSON.parse(JSON.stringify(config)) as GatewayConfig;
  const root = nextConfig as Record<string, unknown>;
  const worker = ensureMutableObject(root, 'worker');
  const openai = ensureMutableObject(worker, 'openai');
  const security = ensureMutableObject(openai, 'security');
  const tools = ensureMutableObject(security, 'tools');
  const tool = ensureMutableObject(tools, entry.configKey);
  tool.approvalMode = approvalMode;
  return nextConfig;
}

function applyDefaultApprovalMode(
  config: GatewayConfig,
  defaultApprovalMode: OpenAiWorkerToolApprovalMode,
): GatewayConfig {
  const nextConfig = JSON.parse(JSON.stringify(config)) as GatewayConfig;
  const root = nextConfig as Record<string, unknown>;
  const worker = ensureMutableObject(root, 'worker');
  const openai = ensureMutableObject(worker, 'openai');
  const security = ensureMutableObject(openai, 'security');
  security.defaultApprovalMode = defaultApprovalMode;
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

export async function setOpenAiWorkerToolApprovalMode(
  id: string,
  approvalMode: OpenAiWorkerToolApprovalMode,
): Promise<OpenAiWorkerToolState> {
  const tool = TOOL_BY_ID.get(id as OpenAiWorkerToolId);
  if (!tool) {
    throw new Error(`Unknown OpenAI worker tool: ${id}`);
  }
  if (!isApprovalMode(approvalMode)) {
    throw new Error(`Invalid OpenAI worker approval mode: ${approvalMode}`);
  }

  const current = await loadGatewayConfig();
  const nextConfig = applyToolApprovalMode(current.config, tool, approvalMode);
  const saved = await saveGatewayConfig(nextConfig, { expectedRevision: current.revision });
  return toToolState(saved.config, tool);
}

export async function getOpenAiWorkerDefaultApprovalMode(): Promise<OpenAiWorkerToolApprovalMode> {
  const state = await loadGatewayConfig();
  return getDefaultApprovalModeFromConfig(state.config);
}

export async function setOpenAiWorkerDefaultApprovalMode(
  defaultApprovalMode: OpenAiWorkerToolApprovalMode,
): Promise<OpenAiWorkerToolApprovalMode> {
  if (!isApprovalMode(defaultApprovalMode)) {
    throw new Error(`Invalid OpenAI worker approval mode: ${defaultApprovalMode}`);
  }
  const current = await loadGatewayConfig();
  const nextConfig = applyDefaultApprovalMode(current.config, defaultApprovalMode);
  const saved = await saveGatewayConfig(nextConfig, { expectedRevision: current.revision });
  return getDefaultApprovalModeFromConfig(saved.config);
}

export function resolveEnabledOpenAiWorkerToolNamesFromConfig(config: GatewayConfig): string[] {
  const enabled = OPENAI_WORKER_TOOL_CATALOG.filter((entry) =>
    getEnabledFromConfig(config, entry),
  ).map((entry) => entry.functionName);
  if (!enabled.includes(BROWSER_USE_PRIMARY_FUNCTION)) {
    return enabled;
  }
  return enabled.filter((name) => !LEGACY_BROWSER_FUNCTIONS.has(name));
}

export function resolveOpenAiWorkerToolApprovalPolicyFromConfig(
  config: GatewayConfig,
  enabledFunctionNames?: string[],
): OpenAiWorkerToolApprovalPolicy {
  const defaultMode = getDefaultApprovalModeFromConfig(config);
  const enabledSet = new Set(
    Array.isArray(enabledFunctionNames) && enabledFunctionNames.length > 0
      ? enabledFunctionNames
      : resolveEnabledOpenAiWorkerToolNamesFromConfig(config),
  );
  const byFunctionName: Record<string, OpenAiWorkerToolApprovalMode> = {};

  for (const entry of OPENAI_WORKER_TOOL_CATALOG) {
    if (!enabledSet.has(entry.functionName)) continue;
    byFunctionName[entry.functionName] = getApprovalModeFromConfig(config, entry);
  }

  return { defaultMode, byFunctionName };
}

export async function listEnabledOpenAiWorkerToolNames(): Promise<string[]> {
  const state = await loadGatewayConfig();
  return resolveEnabledOpenAiWorkerToolNamesFromConfig(state.config);
}
