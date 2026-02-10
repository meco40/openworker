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
  type: string; // MIME type
  url: string; // data URL or object URL
  size: number; // bytes
}

export interface Message {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: string;
  peerId?: string;
  platform: ChannelType;
  attachment?: MessageAttachment;
}

export interface Conversation {
  id: string;
  channelType: ChannelType;
  externalChatId: string | null;
  title: string;
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
  targetTime: string; // ISO String
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
  SECURITY = 'security',
  PROFILE = 'profile',
  TASKS = 'tasks',
  MODELS = 'models',
  WORKER = 'worker',
  TEAMS = 'teams',
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
  authType: 'api_key' | 'oauth';
  authMethods?: Array<'api_key' | 'oauth'>;
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

export enum WorkerTaskStatus {
  PLANNING = 'planning',
  CLARIFYING = 'clarifying',
  IN_PROGRESS = 'in_progress',
  REVIEW = 'review',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface WorkerQuestion {
  id: string;
  text: string;
  options: string[];
}

export interface WorkerArtifact {
  id: string;
  name: string;
  type: 'code' | 'pdf' | 'doc' | 'data' | 'image';
  content: string;
}

export interface Team {
  id: string;
  name: string;
  role: 'Admin' | 'Member' | 'Viewer';
  memberCount: number;
  workspaces: string[];
  tier: 'Starter' | 'Pro' | 'Enterprise';
}

export interface WorkerTask {
  id: string;
  title: string;
  prompt: string;
  status: WorkerTaskStatus;
  usePlanMode: boolean;
  plan: string[];
  currentStepIndex: number;
  questions: WorkerQuestion[];
  answers: Record<string, string>;
  artifacts: WorkerArtifact[];
  result?: string;
  createdAt: string;
  teamId?: string;
}

// Skill interface — supports built-in and externally installed skills
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

// Fixed: Added CommandPermission interface used by SecurityView and constants
export interface CommandPermission {
  id: string;
  command: string;
  description: string;
  category: string;
  risk: 'Low' | 'Medium' | 'High';
  enabled: boolean;
}
