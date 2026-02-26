'use client';

export type Preset = 'today' | 'week' | 'month' | 'custom';
export type RiskFilter = 'all' | 'low' | 'medium' | 'high' | 'flagged';

export interface PromptLogEntry {
  id: string;
  providerId: string;
  modelName: string;
  dispatchKind: 'chat' | 'summary' | 'worker_planner' | 'worker_executor' | 'api_gateway';
  promptTokens: number;
  promptTokensSource: 'exact' | 'estimated';
  completionTokens: number;
  totalTokens: number;
  status: 'success' | 'error';
  errorMessage: string | null;
  riskLevel: 'low' | 'medium' | 'high';
  riskScore: number;
  riskReasons: string[];
  promptPreview: string;
  promptPayloadJson: string;
  promptCostUsd: number | null;
  completionCostUsd: number | null;
  totalCostUsd: number | null;
  createdAt: string;
}

export interface PromptLogSummary {
  totalEntries: number;
  flaggedEntries: number;
  promptTokensTotal: number;
  promptTokensExactCount: number;
  promptTokensEstimatedCount: number;
  totalCostUsd: number;
}

export interface PromptLogsResponse {
  ok: boolean;
  entries: PromptLogEntry[];
  total: number;
  summary: PromptLogSummary;
  diagnostics?: PromptLogDiagnostics;
  error?: string;
}

export interface PromptLogDiagnostics {
  loggerActive: boolean;
  attemptsSinceBoot: number;
  writesSinceBoot: number;
  lastAttemptAt: string | null;
  lastInsertAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface PromptLogsTabProps {
  preset: Preset;
  customFrom: string;
  customTo: string;
  reloadKey?: number;
}

export interface FiltersState {
  search: string;
  risk: RiskFilter;
  provider: string;
  model: string;
}

export interface UsePromptLogsReturn {
  entries: PromptLogEntry[];
  summary: PromptLogSummary | null;
  total: number;
  loading: boolean;
  loadingMore: boolean;
  resetting: boolean;
  error: string | null;
  filters: FiltersState;
  expandedId: string | null;
  providers: string[];
  models: string[];
  hasMore: boolean;
  diagnostics: PromptLogDiagnostics;
  setFilters: (filters: Partial<FiltersState>) => void;
  setExpandedId: (id: string | null) => void;
  fetchPage: (cursor?: string, append?: boolean) => Promise<void>;
  loadMore: () => void;
  resetLogs: () => Promise<void>;
}
