export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogCategory =
  | 'system'
  | 'security'
  | 'channel'
  | 'tooling'
  | 'memory'
  | 'worker'
  | 'diagnostics'
  | 'integration';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  source: string;
  category: LogCategory;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface LogFilter {
  level?: LogLevel;
  source?: string;
  category?: LogCategory;
  search?: string;
  limit?: number;
  before?: string;
}
