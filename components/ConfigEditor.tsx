import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getFieldMetadata,
  mapValidationMessageToFieldPath,
} from '../src/shared/config/fieldMetadata';
import {
  hasHighRiskDiff,
  summarizeConfigDiff,
  type DiffItem,
} from '../src/shared/config/diffSummary';
import {
  ALLOWED_UI_DEFAULT_VIEWS,
  ALLOWED_UI_DENSITIES,
  ALLOWED_UI_TIME_FORMATS,
} from '../src/shared/config/uiSchema';

type StatusTone = 'success' | 'error' | 'info';
type ConfigTab = 'overview' | 'network' | 'runtime' | 'ui' | 'advanced';

interface StatusMessage {
  tone: StatusTone;
  text: string;
}

interface ConfigWarning {
  code: string;
  message: string;
}

interface ConfigResponse {
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

const FALLBACK_PATH = '~/.openclaw/openclaw.json';
const TAB_ITEMS: Array<{ id: ConfigTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'network', label: 'Network' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'ui', label: 'Web UI' },
  { id: 'advanced', label: 'Advanced JSON' },
];

const DEFAULT_CONFIG: Record<string, unknown> = {
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

function toJsonString(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getOrCreateObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key];
  if (isObject(current)) {
    return current;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function readString(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function readNumber(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeHostFromBind(bind: string): string {
  if (bind === 'loopback') return '127.0.0.1';
  if (bind === 'all') return '0.0.0.0';
  return bind;
}

function normalizeBindFromHost(host: string): string {
  if (host === '127.0.0.1' || host === 'localhost') return 'loopback';
  if (host === '0.0.0.0') return 'all';
  return host;
}

const STATUS_CLASS: Record<StatusTone, string> = {
  success: 'text-emerald-400 border-emerald-500/20 bg-emerald-500/10',
  error: 'text-rose-400 border-rose-500/20 bg-rose-500/10',
  info: 'text-zinc-300 border-zinc-700 bg-zinc-900/50',
};

function riskBadgeClass(risk: DiffItem['risk']): string {
  if (risk === 'restart-required')
    return 'bg-amber-500/20 text-amber-200 border border-amber-400/40';
  if (risk === 'sensitive') return 'bg-rose-500/20 text-rose-200 border border-rose-400/40';
  return 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/40';
}

const ConfigEditor: React.FC = () => {
  const [config, setConfig] = useState(() => toJsonString(DEFAULT_CONFIG));
  const [baselineConfig, setBaselineConfig] = useState<Record<string, unknown>>(DEFAULT_CONFIG);
  const [baselineRevision, setBaselineRevision] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<ConfigTab>('overview');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationFieldPath, setValidationFieldPath] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const [compatibilityWarnings, setCompatibilityWarnings] = useState<ConfigWarning[]>([]);
  const [configPath, setConfigPath] = useState(FALLBACK_PATH);
  const [configSource, setConfigSource] = useState<'default' | 'file' | 'unknown'>('unknown');
  const [showDiffPreview, setShowDiffPreview] = useState(false);
  const [pendingParsedConfig, setPendingParsedConfig] = useState<Record<string, unknown> | null>(
    null,
  );
  const [diffItems, setDiffItems] = useState<DiffItem[]>([]);
  const [conflictRevision, setConflictRevision] = useState<string | null>(null);

  const parsedConfig = useMemo(() => {
    try {
      const parsed = JSON.parse(config) as unknown;
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }, [config]);

  const gateway = isObject(parsedConfig?.gateway) ? parsedConfig.gateway : {};
  const ui = isObject(parsedConfig?.ui) ? parsedConfig.ui : {};
  const bindValue = readString(
    gateway,
    'bind',
    normalizeBindFromHost(readString(gateway, 'host', '0.0.0.0')),
  );
  const bindPreset = bindValue === 'loopback' || bindValue === 'all' ? bindValue : 'custom';
  const hostValue = readString(gateway, 'host', normalizeHostFromBind(bindValue));

  const fieldErrorFor = useCallback(
    (path: string) => (validationError && validationFieldPath === path ? validationError : null),
    [validationError, validationFieldPath],
  );

  const loadConfig = useCallback(async () => {
    setIsLoading(true);
    setStatusMessage(null);
    setConflictRevision(null);
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      const payload = (await response.json()) as ConfigResponse;
      if (!response.ok || !payload.ok || !payload.config) {
        throw new Error(payload.error || 'Failed to load config.');
      }
      setConfig(toJsonString(payload.config));
      setBaselineConfig(payload.config);
      setBaselineRevision(String(payload.revision || ''));
      setConfigPath(payload.displayPath || FALLBACK_PATH);
      setConfigSource(payload.source || 'unknown');
      setCompatibilityWarnings(payload.warnings || []);
      setValidationError(null);
      setValidationFieldPath(null);
      setHasChanges(false);
      setShowDiffPreview(false);
      setPendingParsedConfig(null);
      setDiffItems([]);
      if (payload.source === 'default') {
        setStatusMessage({ tone: 'info', text: 'No config file found. Loaded default config.' });
      } else if ((payload.warnings || []).length > 0) {
        setStatusMessage({
          tone: 'info',
          text: `Config loaded with ${(payload.warnings || []).length} compatibility warning(s).`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load config.';
      setCompatibilityWarnings([]);
      setStatusMessage({ tone: 'error', text: message });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (event: BeforeUnloadEvent) => {
      if (!hasChanges) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasChanges]);

  const updateConfigDraft = useCallback((mutate: (draft: Record<string, unknown>) => void) => {
    setConfig((previous) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(previous) as unknown;
      } catch (error) {
        setValidationError(error instanceof Error ? error.message : 'Invalid JSON.');
        setValidationFieldPath(null);
        return previous;
      }
      if (!isObject(parsed)) {
        setValidationError('Config root must be an object.');
        setValidationFieldPath(null);
        return previous;
      }
      const draft = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
      mutate(draft);
      setValidationError(null);
      setValidationFieldPath(null);
      setHasChanges(true);
      setConflictRevision(null);
      return toJsonString(draft);
    });
  }, []);

  const parseCurrentConfig = useCallback((): Record<string, unknown> | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(config) as unknown;
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'Invalid JSON.');
      setValidationFieldPath(null);
      setStatusMessage({ tone: 'error', text: 'Apply failed. Invalid JSON.' });
      return null;
    }

    if (!isObject(parsed)) {
      setValidationError('Config root must be an object.');
      setValidationFieldPath(null);
      setStatusMessage({ tone: 'error', text: 'Apply failed. Config root must be an object.' });
      return null;
    }

    return parsed;
  }, [config]);

  const executeApply = useCallback(async (parsed: Record<string, unknown>, revision: string) => {
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const response = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: parsed, revision }),
      });
      const payload = (await response.json()) as ConfigResponse;

      if (!response.ok || !payload.ok || !payload.config) {
        const message = payload.error || 'Failed to save config.';
        if (payload.code === 'CONFIG_STALE_REVISION') {
          setConflictRevision(payload.currentRevision || null);
          setStatusMessage({
            tone: 'error',
            text: 'Config changed in another session. Reload latest config or review diff before retry.',
          });
        } else {
          setStatusMessage({ tone: 'error', text: message });
        }
        setValidationError(message);
        setValidationFieldPath(mapValidationMessageToFieldPath(message));
        return;
      }

      setConfig(toJsonString(payload.config));
      setBaselineConfig(payload.config);
      setBaselineRevision(String(payload.revision || ''));
      setConfigPath(payload.displayPath || FALLBACK_PATH);
      setConfigSource(payload.source || 'file');
      setCompatibilityWarnings(payload.warnings || []);
      setValidationError(null);
      setValidationFieldPath(null);
      setHasChanges(false);
      setShowDiffPreview(false);
      setPendingParsedConfig(null);
      setDiffItems([]);
      setConflictRevision(null);

      if ((payload.warnings || []).length > 0) {
        setStatusMessage({
          tone: 'info',
          text: `Config saved with ${(payload.warnings || []).length} compatibility warning(s).`,
        });
      } else {
        setStatusMessage({ tone: 'success', text: 'Config saved successfully.' });
      }
    } catch (error) {
      setStatusMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Failed to save config.',
      });
    } finally {
      setIsSaving(false);
    }
  }, []);

  const openDiffPreview = () => {
    const parsed = parseCurrentConfig();
    if (!parsed) return;
    setDiffItems(summarizeConfigDiff(baselineConfig, parsed));
    setPendingParsedConfig(parsed);
    setShowDiffPreview(true);
  };

  const handleConfirmApply = async (revisionOverride?: string) => {
    if (!pendingParsedConfig) return;
    const revisionToUse = revisionOverride || baselineRevision;
    if (!revisionToUse) {
      setStatusMessage({
        tone: 'error',
        text: 'Missing config revision. Reload config before applying changes.',
      });
      return;
    }
    await executeApply(pendingParsedConfig, revisionToUse);
  };

  const canApply = hasChanges && !isSaving && !isLoading && !validationError;
  const simpleModeDisabled = activeTab !== 'advanced' && parsedConfig === null;
  const hasHighRiskChanges = hasHighRiskDiff(diffItems);

  return (
    <div className="flex h-full flex-col space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white">Gateway Config</h2>
          <p className="text-sm text-zinc-500">Simple tabbed setup with advanced JSON editing.</p>
        </div>
        <div className="flex space-x-3">
          <button
            aria-label="Reload config"
            disabled={isLoading || isSaving}
            onClick={() => void loadConfig()}
            className="rounded bg-zinc-800 px-4 py-2 text-xs font-bold tracking-widest text-zinc-300 uppercase hover:bg-zinc-700 disabled:opacity-60"
          >
            Reload
          </button>
          <button
            aria-label="Open apply preview"
            disabled={!canApply}
            onClick={openDiffPreview}
            className={`rounded px-6 py-2 text-xs font-bold tracking-widest uppercase transition-all ${
              canApply
                ? 'bg-indigo-600 text-white shadow-lg hover:bg-indigo-700'
                : 'cursor-not-allowed bg-zinc-800 text-zinc-600'
            }`}
          >
            {isSaving ? 'Saving...' : 'Apply Config'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {TAB_ITEMS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`rounded border px-3 py-2 text-[11px] font-bold tracking-widest uppercase ${
              activeTab === tab.id
                ? 'border-indigo-500/40 bg-indigo-600/20 text-indigo-300'
                : 'border-zinc-800 bg-zinc-900 text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {statusMessage && (
        <div className={`rounded-lg border px-4 py-3 text-xs ${STATUS_CLASS[statusMessage.tone]}`}>
          {statusMessage.text}
        </div>
      )}

      {conflictRevision && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3">
          <div className="mb-2 text-xs text-rose-200">Stale revision detected.</div>
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-200"
              onClick={() => void loadConfig()}
            >
              Reload latest
            </button>
            <button
              className="rounded bg-indigo-700 px-3 py-1 text-xs text-white"
              onClick={() => {
                if (pendingParsedConfig) {
                  void handleConfirmApply(conflictRevision);
                }
              }}
            >
              Try apply again
            </button>
          </div>
        </div>
      )}

      {showDiffPreview && (
        <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-4 py-3">
          <h4 className="mb-2 text-[10px] font-bold tracking-widest text-indigo-200 uppercase">
            Apply Preview
          </h4>
          {diffItems.length === 0 ? (
            <div className="text-xs text-zinc-400">No effective changes found.</div>
          ) : (
            <ul className="space-y-2 text-xs">
              {diffItems.map((item) => (
                <li key={item.path} className="flex items-center justify-between gap-3">
                  <span className="font-mono text-zinc-200">{item.path}</span>
                  <span
                    className={`rounded px-2 py-0.5 text-[10px] uppercase ${riskBadgeClass(item.risk)}`}
                  >
                    {item.risk}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {hasHighRiskChanges && (
            <div className="mt-3 text-xs text-amber-200">
              This change contains high-risk fields. Confirm carefully.
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button
              className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-200"
              onClick={() => setShowDiffPreview(false)}
            >
              Cancel
            </button>
            <button
              className="rounded bg-indigo-700 px-3 py-1 text-xs text-white"
              onClick={() => void handleConfirmApply()}
            >
              Confirm Apply
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4 py-2">
          <span className="font-mono text-[10px] text-zinc-500">{configPath}</span>
          <div className="flex items-center space-x-4">
            <span className="font-mono text-[10px] text-zinc-500 uppercase">
              Source: {configSource === 'unknown' ? 'n/a' : configSource}
            </span>
            <span className="font-mono text-[10px] text-zinc-500 uppercase">
              Revision: {baselineRevision || 'n/a'}
            </span>
          </div>
        </div>

        <div className="space-y-4 overflow-auto p-5">
          {simpleModeDisabled && (
            <div className="rounded border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
              Simple tab editing is disabled until the JSON in Advanced mode is valid.
            </div>
          )}

          {activeTab === 'overview' && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="rounded border border-zinc-800 bg-zinc-900/60 p-4">
                <div className="mb-1 text-[10px] tracking-widest text-zinc-500 uppercase">
                  Config Source
                </div>
                <div className="font-mono text-sm text-zinc-200">{configSource}</div>
              </div>
              <div className="rounded border border-zinc-800 bg-zinc-900/60 p-4">
                <div className="mb-1 text-[10px] tracking-widest text-zinc-500 uppercase">
                  Pending Changes
                </div>
                <div className="font-mono text-sm text-zinc-200">{hasChanges ? 'yes' : 'no'}</div>
              </div>
              <div className="rounded border border-zinc-800 bg-zinc-900/60 p-4">
                <div className="mb-1 text-[10px] tracking-widest text-zinc-500 uppercase">
                  Warnings
                </div>
                <div className="font-mono text-sm text-zinc-200">
                  {compatibilityWarnings.length}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'network' && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-[10px] tracking-widest text-zinc-500 uppercase">Port</span>
                <input
                  aria-label="Gateway port"
                  type="number"
                  min={1}
                  max={65535}
                  value={readNumber(gateway, 'port', 8080)}
                  disabled={simpleModeDisabled}
                  onChange={(event) => {
                    const port = Number.parseInt(event.target.value, 10);
                    if (!Number.isFinite(port)) return;
                    updateConfigDraft((draft) => {
                      const draftGateway = getOrCreateObject(draft, 'gateway');
                      draftGateway.port = port;
                    });
                  }}
                  className={`w-full rounded border bg-zinc-900 px-3 py-2 text-sm text-white ${fieldErrorFor('gateway.port') ? 'border-rose-500' : 'border-zinc-700'}`}
                />
                <div className="text-[11px] text-zinc-500">
                  {getFieldMetadata('gateway.port')?.helper}
                </div>
              </label>
              <label className="space-y-2">
                <span className="text-[10px] tracking-widest text-zinc-500 uppercase">
                  Bind Preset
                </span>
                <select
                  aria-label="Gateway bind preset"
                  value={bindPreset}
                  disabled={simpleModeDisabled}
                  onChange={(event) => {
                    const bind = event.target.value;
                    updateConfigDraft((draft) => {
                      const draftGateway = getOrCreateObject(draft, 'gateway');
                      if (bind === 'loopback' || bind === 'all') {
                        draftGateway.bind = bind;
                        draftGateway.host = normalizeHostFromBind(bind);
                      }
                    });
                  }}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white"
                >
                  <option value="loopback">Loopback (127.0.0.1)</option>
                  <option value="all">All Interfaces (0.0.0.0)</option>
                  <option value="custom">Custom</option>
                </select>
                <div className="text-[11px] text-zinc-500">
                  {getFieldMetadata('gateway.bind')?.helper}
                </div>
              </label>
              <label className="space-y-2 md:col-span-2">
                <span className="text-[10px] tracking-widest text-zinc-500 uppercase">Host</span>
                <input
                  aria-label="Gateway host"
                  type="text"
                  value={hostValue}
                  disabled={simpleModeDisabled}
                  onChange={(event) => {
                    const host = event.target.value;
                    updateConfigDraft((draft) => {
                      const draftGateway = getOrCreateObject(draft, 'gateway');
                      draftGateway.host = host;
                      draftGateway.bind = normalizeBindFromHost(host);
                    });
                  }}
                  className={`w-full rounded border bg-zinc-900 px-3 py-2 text-sm text-white ${fieldErrorFor('gateway.host') ? 'border-rose-500' : 'border-zinc-700'}`}
                />
                <div className="text-[11px] text-zinc-500">
                  {getFieldMetadata('gateway.host')?.helper}
                </div>
              </label>
            </div>
          )}

          {activeTab === 'runtime' && (
            <label className="space-y-2">
              <span className="text-[10px] tracking-widest text-zinc-500 uppercase">Log Level</span>
              <select
                aria-label="Gateway log level"
                value={readString(gateway, 'logLevel', 'info')}
                disabled={simpleModeDisabled}
                onChange={(event) => {
                  const logLevel = event.target.value;
                  updateConfigDraft((draft) => {
                    const draftGateway = getOrCreateObject(draft, 'gateway');
                    draftGateway.logLevel = logLevel;
                  });
                }}
                className={`w-full rounded border bg-zinc-900 px-3 py-2 text-sm text-white ${fieldErrorFor('gateway.logLevel') ? 'border-rose-500' : 'border-zinc-700'}`}
              >
                <option value="debug">debug</option>
                <option value="info">info</option>
                <option value="warn">warn</option>
                <option value="error">error</option>
              </select>
              <div className="text-[11px] text-zinc-500">
                {getFieldMetadata('gateway.logLevel')?.helper}
              </div>
            </label>
          )}

          {activeTab === 'ui' && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-[10px] tracking-widest text-zinc-500 uppercase">
                  Default View
                </span>
                <select
                  aria-label="Default view"
                  value={readString(ui, 'defaultView', 'dashboard')}
                  disabled={simpleModeDisabled}
                  onChange={(event) => {
                    updateConfigDraft((draft) => {
                      getOrCreateObject(draft, 'ui').defaultView = event.target.value;
                    });
                  }}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white"
                >
                  {ALLOWED_UI_DEFAULT_VIEWS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-2">
                <span className="text-[10px] tracking-widest text-zinc-500 uppercase">Density</span>
                <select
                  aria-label="UI density"
                  value={readString(ui, 'density', 'comfortable')}
                  disabled={simpleModeDisabled}
                  onChange={(event) => {
                    updateConfigDraft((draft) => {
                      getOrCreateObject(draft, 'ui').density = event.target.value;
                    });
                  }}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white"
                >
                  {ALLOWED_UI_DENSITIES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-2">
                <span className="text-[10px] tracking-widest text-zinc-500 uppercase">
                  Language
                </span>
                <input
                  aria-label="UI language"
                  value={readString(ui, 'language', 'de-DE')}
                  disabled={simpleModeDisabled}
                  onChange={(event) => {
                    updateConfigDraft((draft) => {
                      getOrCreateObject(draft, 'ui').language = event.target.value;
                    });
                  }}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white"
                />
              </label>
              <label className="space-y-2">
                <span className="text-[10px] tracking-widest text-zinc-500 uppercase">
                  Time Format
                </span>
                <select
                  aria-label="UI time format"
                  value={readString(ui, 'timeFormat', '24h')}
                  disabled={simpleModeDisabled}
                  onChange={(event) => {
                    updateConfigDraft((draft) => {
                      getOrCreateObject(draft, 'ui').timeFormat = event.target.value;
                    });
                  }}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white"
                >
                  {ALLOWED_UI_TIME_FORMATS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {activeTab === 'advanced' && (
            <textarea
              aria-label="Advanced JSON editor"
              value={config}
              onChange={(event) => {
                const next = event.target.value;
                setConfig(next);
                setHasChanges(true);
                setConflictRevision(null);
                try {
                  const parsed = JSON.parse(next) as unknown;
                  if (!isObject(parsed)) {
                    setValidationError('Config root must be an object.');
                    setValidationFieldPath(null);
                    return;
                  }
                  setValidationError(null);
                  setValidationFieldPath(null);
                } catch (error) {
                  setValidationError(error instanceof Error ? error.message : 'Invalid JSON.');
                  setValidationFieldPath(null);
                }
              }}
              spellCheck={false}
              disabled={isLoading}
              className="min-h-[420px] w-full resize-y rounded border border-zinc-800 bg-transparent p-4 font-mono text-sm text-indigo-300 focus:outline-none disabled:opacity-60"
            />
          )}
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h4 className="mb-2 text-[10px] font-bold text-zinc-500 uppercase">Validation</h4>
        {validationError ? (
          <div className="font-mono text-xs text-rose-400">
            [ERROR] {validationError}
            {validationFieldPath && getFieldMetadata(validationFieldPath)
              ? ` | Field: ${getFieldMetadata(validationFieldPath)?.label}`
              : ''}
          </div>
        ) : (
          <div className="font-mono text-xs text-emerald-500">[OK] No schema violations found.</div>
        )}
      </div>
    </div>
  );
};

export default ConfigEditor;
