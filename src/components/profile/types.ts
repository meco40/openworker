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
  revision?: string;
  warnings?: ConfigWarning[];
  error?: string;
  code?: string;
  currentRevision?: string;
}

export const STATUS_CLASS: Record<StatusTone, string> = {
  success: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
  error: 'text-rose-300 border-rose-500/30 bg-rose-500/10',
  info: 'text-zinc-200 border-zinc-700 bg-zinc-900/60',
};
