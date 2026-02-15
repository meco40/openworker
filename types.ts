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

export interface ControlPlaneMetrics {
  uptimeSeconds: number;
  pendingWorkerTasks: number;
  activeWsSessions: number;
  tokensToday: number;
  vectorNodeCount: number;
  orchestra?: {
    runCount: number;
    failFastAbortCount: number;
    activeSubagentSessions: number;
  };
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
  WORKER = 'worker',
  PERSONAS = 'personas',
  MEMORY = 'memory',
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

export type WorkspaceType = 'research' | 'webapp' | 'creative' | 'data' | 'general';

export enum WorkerTaskStatus {
  INBOX = 'inbox',
  QUEUED = 'queued',
  ASSIGNED = 'assigned',
  PLANNING = 'planning',
  CLARIFYING = 'clarifying',
  EXECUTING = 'executing',
  WAITING_APPROVAL = 'waiting_approval',
  TESTING = 'testing',
  REVIEW = 'review',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  INTERRUPTED = 'interrupted',
}

export interface WorkerQuestion {
  id: string;
  text: string;
  options: string[];
}

export interface WorkerArtifact {
  id: string;
  name: string;
  type: string;
  content: string;
  mimeType: string | null;
}

export interface WorkerStep {
  id: string;
  taskId: string;
  stepIndex: number;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  output: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkspaceFile {
  name: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
  isDirectory: boolean;
}

export interface WorkerTask {
  id: string;
  title: string;
  objective: string;
  status: WorkerTaskStatus;
  workspaceType: WorkspaceType;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  currentStep: number;
  totalSteps: number;
  resultSummary: string | null;
  errorMessage: string | null;
  workspacePath: string | null;
  resumable: boolean;
  assignedPersonaId: string | null;
  planningMessages: string | null;
  planningComplete: boolean;
  steps?: WorkerStep[];
  artifacts?: WorkerArtifact[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkerActivity {
  id: string;
  taskId: string;
  type:
    | 'status_change'
    | 'persona_assigned'
    | 'step_completed'
    | 'step_failed'
    | 'error'
    | 'note'
    | 'agent_message';
  message: string;
  metadata: string | null;
  createdAt: string;
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
