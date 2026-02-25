export enum ChannelType {
  WHATSAPP = 'WhatsApp',
  TELEGRAM = 'Telegram',
  SLACK = 'Slack',
  DISCORD = 'Discord',
  WEBCHAT = 'WebChat',
  SIGNAL = 'Signal',
  TEAMS = 'Teams',
  IMESSAGE = 'iMessage',
}

export interface Peer {
  id: string;
  username: string;
  avatar?: string;
  platform: ChannelType;
}

export interface MessageAttachment {
  name: string;
  type: string;
  url: string;
  size: number;
}

export type ChatApprovalDecision = 'approve_once' | 'approve_always' | 'deny';

export interface MessageApprovalRequest {
  token: string;
  prompt?: string;
  toolId?: string;
  toolFunctionName?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: string;
  peerId?: string;
  conversationId?: string;
  platform: ChannelType;
  attachment?: MessageAttachment;
  streaming?: boolean;
  approvalRequest?: MessageApprovalRequest;
  approvalSubmitting?: boolean;
  approvalResolved?: ChatApprovalDecision;
  approvalError?: string;
}

export interface ChatStreamDebugState {
  phase: 'idle' | 'running' | 'done' | 'error';
  transport: 'unknown' | 'live-delta' | 'final-only';
  message?: string;
  updatedAt: string;
  /** Currently executing tool name, if any (set while agent runs a tool call) */
  activeToolCall?: string | null;
}

export interface Conversation {
  id: string;
  channelType: ChannelType;
  externalChatId: string | null;
  userId: string;
  title: string;
  modelOverride: string | null;
  personaId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEntry {
  id: string;
  type: 'fact' | 'preference' | 'avoidance' | 'lesson' | 'personality_trait' | 'workflow_pattern';
  content: string;
  timestamp: string;
  importance: number;
}

export interface ScheduledTask {
  id: string;
  targetTime: string;
  content: string;
  platform: ChannelType;
  status: 'pending' | 'triggered' | 'cancelled';
}

export interface GatewayState {
  version: string;
  uptime: number;
  cpuUsage: number;
  memoryUsage: number;
  activeSessions: number;
  onboarded: boolean;
  totalTokens: number;
  eventHistory: SystemLog[];
  trafficData: { name: string; tokens: number }[];
  memoryEntries: MemoryEntry[];
  scheduledTasks: ScheduledTask[];
}

export interface ControlPlaneMetrics {
  uptimeSeconds: number;
  activeWsSessions: number;
  tokensToday: number;
  vectorNodeCount: number;
  ramUsageBytes?: number;
  rooms?: {
    totalRooms: number;
    runningRooms: number;
    totalMembers: number;
    totalMessages: number;
  } | null;
  automation?: {
    activeRules: number;
    queuedRuns: number;
    runningRuns: number;
    deadLetterRuns: number;
    leaseAgeSeconds: number | null;
  } | null;
  generatedAt: string;
}

export interface ControlPlaneMetricsState {
  metrics: ControlPlaneMetrics | null;
  loading: boolean;
  stale: boolean;
  error: string | null;
}

export interface SystemLog {
  timestamp: string;
  type: 'AUTH' | 'CHAN' | 'TOOL' | 'SYS' | 'MEM' | 'TASK';
  message: string;
}

export enum View {
  DASHBOARD = 'dashboard',
  CHAT = 'chat',
  CONFIG = 'config',
  SKILLS = 'skills',
  EXPOSURE = 'exposure',
  WIZARD = 'wizard',
  CHANNELS = 'channels',
  LOGS = 'logs',
  STATS = 'stats',
  SECURITY = 'security',
  PROFILE = 'profile',
  TASKS = 'tasks',
  MODELS = 'models',
  PERSONAS = 'personas',
  MEMORY = 'memory',
  KNOWLEDGE = 'knowledge',
  MISSION_CONTROL = 'mission_control',
  CRON = 'cron',
  INSTANCES = 'instances',
  SESSIONS = 'sessions',
  NODES = 'nodes',
  AGENTS = 'agents',
  DEBUGGER = 'debugger',
}

export interface DebugConversationSummary {
  conversationId: string;
  turnCount: number;
  totalTokens: number;
  totalCostUsd: number | null;
  lastActivity: string;
  modelName: string;
}

export interface DebugTurn {
  seq: number;
  userPreview: string;
  assistantPreview: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number | null;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  memoryContext: string | null;
  riskLevel: 'low' | 'medium' | 'high';
  dispatchId: string;
}

export interface CoupledChannel {
  type: ChannelType;
  status: 'idle' | 'pairing' | 'awaiting_code' | 'connected';
  peerName?: string;
  connectedAt?: string;
}

export interface AIProvider {
  id: string;
  name: string;
  authType: 'none' | 'api_key' | 'oauth';
  authMethods?: Array<'none' | 'api_key' | 'oauth'>;
  endpointType?:
    | 'gemini-native'
    | 'openai-compatible'
    | 'openai-native'
    | 'anthropic-native'
    | 'xai-native'
    | 'mistral-native'
    | 'cohere-native'
    | 'copilot-native'
    | 'github-native';
  capabilities?: Array<'chat' | 'tools' | 'vision' | 'audio' | 'embeddings' | 'code_pairing'>;
  icon: string;
  availableModels: string[];
}

export interface ConfiguredModel {
  id: string;
  accountId?: string;
  providerId: string;
  name: string;
  priority: number;
  status: 'active' | 'rate-limited' | 'offline';
}

export interface ModelProfile {
  id: string;
  name: string;
  description: string;
  stack: ConfiguredModel[];
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  installed: boolean;
  version: string;
  functionName: string;
  source: 'built-in' | 'github' | 'npm' | 'manual';
  sourceUrl?: string;
}

export interface CommandPermission {
  id: string;
  command: string;
  description: string;
  category: string;
  risk: 'Low' | 'Medium' | 'High';
  enabled: boolean;
}
