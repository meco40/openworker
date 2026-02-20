export type StatusTone = 'success' | 'error' | 'info';
export type ConfigTab = 'overview' | 'network' | 'runtime' | 'ui' | 'advanced';

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

export const FALLBACK_PATH = '~/.openclaw/openclaw.json';

export const TAB_ITEMS: Array<{ id: ConfigTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'network', label: 'Network' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'ui', label: 'Web UI' },
  { id: 'advanced', label: 'Advanced JSON' },
];

export const DEFAULT_CONFIG: Record<string, unknown> = {
  gateway: { port: 8080, host: '0.0.0.0', bind: 'all', logLevel: 'info' },
  provider: { primary: 'gemini-3-flash-preview', fallback: 'gemini-3-pro-preview', rotation: true },
  channels: {
    webchat: { enabled: true },
    telegram: { enabled: true, token: 'ENV_T_TOKEN' },
    slack: { enabled: false },
  },
  tools: {
    browser: { managed: true, headless: true },
    sandbox: { type: 'docker', enabled: false },
  },
  ui: {
    defaultView: 'dashboard',
    density: 'comfortable',
    language: 'de-DE',
    timeFormat: '24h',
    showAdvancedDebug: false,
  },
};

export const STATUS_CLASS: Record<StatusTone, string> = {
  success: 'text-emerald-400 border-emerald-500/20 bg-emerald-500/10',
  error: 'text-rose-400 border-rose-500/20 bg-rose-500/10',
  info: 'text-zinc-300 border-zinc-700 bg-zinc-900/50',
};
