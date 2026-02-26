export interface TokenTotal {
  prompt: number;
  completion: number;
  total: number;
}

export interface ModelUsage {
  provider: string;
  model: string;
  prompt: number;
  completion: number;
  total: number;
}

export interface SessionLensSummary {
  totalSessions: number;
  byChannel: Array<{
    channelType: string;
    count: number;
  }>;
  topSessions: Array<{
    id: string;
    title: string;
    channelType: string;
    externalChatId: string | null;
    modelOverride: string | null;
    personaId: string | null;
    updatedAt: string;
  }>;
}

export interface StatsResponse {
  ok: boolean;
  overview: {
    uptimeSeconds: number;
    totalRequests: number;
  };
  tokenUsage: {
    total: TokenTotal;
    byModel: ModelUsage[];
  };
  sessionLens?: SessionLensSummary;
  error?: string;
}

export type Preset = 'today' | 'week' | 'month' | 'custom';
export type StatsTab = 'overview' | 'logs' | 'sessions';

