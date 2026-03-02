export type StatusTone = 'success' | 'error' | 'info';

export interface StatusMessage {
  tone: StatusTone;
  text: string;
}

export interface ConfigWarning {
  code: string;
  message: string;
}

export interface ConfigResponse {
  ok: boolean;
  config?: Record<string, unknown>;
  source?: 'default' | 'file';
  displayPath?: string;
  warnings?: ConfigWarning[];
  revision?: string;
  currentRevision?: string;
  error?: string;
  code?: string;
}
