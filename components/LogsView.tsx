
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getGatewayClient } from '../src/modules/gateway/ws-client';

// ── Types ────────────────────────────────────────────────────────

interface LogEntry {
  id: string;
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  category:
    | 'system'
    | 'security'
    | 'channel'
    | 'tooling'
    | 'memory'
    | 'worker'
    | 'diagnostics'
    | 'integration';
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

type LevelFilter = 'all' | 'debug' | 'info' | 'warn' | 'error';
type DiagnosticsStatus = 'ok' | 'degraded' | 'critical' | 'unknown';

interface HealthSummary {
  ok: number;
  warning: number;
  critical: number;
  skipped: number;
}

interface HealthDiagnosticsState {
  status: DiagnosticsStatus;
  summary: HealthSummary | null;
  issues: string[];
  generatedAt: string | null;
  error: string | null;
}

interface DoctorDiagnosticsState {
  status: DiagnosticsStatus;
  findingsCount: number;
  recommendationsCount: number;
  findingDetails: string[];
  recommendations: string[];
  generatedAt: string | null;
  error: string | null;
}

interface HealthCheckSnapshot {
  id?: unknown;
  status?: unknown;
  message?: unknown;
}

interface DoctorFindingSnapshot {
  severity?: unknown;
  title?: unknown;
  detail?: unknown;
}

interface HealthApiResponse {
  ok?: boolean;
  status?: 'ok' | 'degraded' | 'critical';
  summary?: HealthSummary;
  checks?: HealthCheckSnapshot[];
  generatedAt?: string;
  error?: string;
}

interface DoctorApiResponse {
  ok?: boolean;
  status?: 'ok' | 'degraded' | 'critical';
  findings?: DoctorFindingSnapshot[];
  recommendations?: string[];
  generatedAt?: string;
  error?: string;
}

// ── Helpers ──────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString();
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const LEVEL_CONFIG: Record<string, { color: string; bg: string; badge: string }> = {
  debug: { color: 'text-zinc-400', bg: 'bg-zinc-500/10', badge: 'border-zinc-600' },
  info: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', badge: 'border-emerald-500/40' },
  warn: { color: 'text-amber-400', bg: 'bg-amber-500/10', badge: 'border-amber-500/40' },
  error: { color: 'text-rose-400', bg: 'bg-rose-500/10', badge: 'border-rose-500/40' },
};

const SOURCE_COLORS: Record<string, string> = {
  SYS: 'text-violet-400',
  AUTH: 'text-cyan-400',
  CHAN: 'text-blue-400',
  TOOL: 'text-emerald-400',
  MEM: 'text-pink-400',
  TASK: 'text-amber-400',
  GATEWAY: 'text-indigo-400',
  BRIDGE: 'text-orange-400',
  SKILLS: 'text-teal-400',
};

const DIAGNOSTIC_STATUS_CONFIG: Record<
  DiagnosticsStatus,
  { label: string; textClass: string; borderClass: string; bgClass: string }
> = {
  ok: {
    label: 'OK',
    textClass: 'text-emerald-400',
    borderClass: 'border-emerald-500/40',
    bgClass: 'bg-emerald-500/10',
  },
  degraded: {
    label: 'DEGRADED',
    textClass: 'text-amber-400',
    borderClass: 'border-amber-500/40',
    bgClass: 'bg-amber-500/10',
  },
  critical: {
    label: 'CRITICAL',
    textClass: 'text-rose-400',
    borderClass: 'border-rose-500/40',
    bgClass: 'bg-rose-500/10',
  },
  unknown: {
    label: 'UNKNOWN',
    textClass: 'text-zinc-500',
    borderClass: 'border-zinc-700',
    bgClass: 'bg-zinc-800/70',
  },
};

function parseDiagnosticsStatus(value: unknown): DiagnosticsStatus {
  if (value === 'ok' || value === 'degraded' || value === 'critical') {
    return value;
  }
  return 'unknown';
}

export function extractHealthIssues(
  checks: HealthCheckSnapshot[] | undefined,
  limit = 3,
): string[] {
  if (!Array.isArray(checks)) return [];

  return checks
    .filter((check) => check?.status === 'warning' || check?.status === 'critical')
    .map((check) => {
      const id = typeof check.id === 'string' ? check.id : 'unknown_check';
      const message = typeof check.message === 'string' ? check.message : 'No details available.';
      return `${id}: ${message}`;
    })
    .slice(0, limit);
}

export function extractDoctorFindingDetails(
  findings: DoctorFindingSnapshot[] | undefined,
  limit = 3,
): string[] {
  if (!Array.isArray(findings)) return [];

  return findings
    .map((finding) => {
      const title = typeof finding.title === 'string' ? finding.title : 'Finding';
      const detail =
        typeof finding.detail === 'string' ? finding.detail : 'No details available.';
      return `${title}: ${detail}`;
    })
    .slice(0, limit);
}

// ── Component ────────────────────────────────────────────────────

const LogsView: React.FC = () => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [sources, setSources] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [healthDiagnostics, setHealthDiagnostics] = useState<HealthDiagnosticsState>({
    status: 'unknown',
    summary: null,
    issues: [],
    generatedAt: null,
    error: null,
  });
  const [doctorDiagnostics, setDoctorDiagnostics] = useState<DoctorDiagnosticsState>({
    status: 'unknown',
    findingsCount: 0,
    recommendationsCount: 0,
    findingDetails: [],
    recommendations: [],
    generatedAt: null,
    error: null,
  });
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Fetch historical logs ──────────────────────────────────

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (levelFilter !== 'all') params.set('level', levelFilter);
      if (sourceFilter !== 'all') params.set('source', sourceFilter);
      if (categoryFilter !== 'all') params.set('category', categoryFilter);
      if (search) params.set('search', search);
      params.set('limit', '500');

      const res = await fetch(`/api/logs?${params.toString()}`);
      const data = await res.json();
      if (data.ok) {
        setLogs(data.logs);
        setTotalCount(data.total);
      }
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [categoryFilter, levelFilter, sourceFilter, search]);

  const fetchSources = useCallback(async () => {
    try {
      const res = await fetch('/api/logs?sources=1');
      const data = await res.json();
      if (data.ok) setSources(data.sources);
    } catch {
      // Silently fail
    }
  }, []);

  const fetchCategories = useCallback(async () => {
    try {
      const res = await fetch('/api/logs?categories=1');
      const data = await res.json();
      if (data.ok) setCategories(data.categories);
    } catch {
      // Silently fail
    }
  }, []);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    void fetchSources();
  }, [fetchSources]);

  useEffect(() => {
    void fetchCategories();
  }, [fetchCategories]);

  const fetchDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);

    const [healthResult, doctorResult] = await Promise.allSettled([
      fetch('/api/health'),
      fetch('/api/doctor'),
    ]);

    if (healthResult.status === 'fulfilled') {
      try {
        const payload = (await healthResult.value.json()) as HealthApiResponse;
        if (!healthResult.value.ok || payload.ok === false) {
          setHealthDiagnostics({
            status: 'unknown',
            summary: null,
            issues: [],
            generatedAt: null,
            error: payload.error || 'Health endpoint is not accessible.',
          });
        } else {
          setHealthDiagnostics({
            status: parseDiagnosticsStatus(payload.status),
            summary: payload.summary || null,
            issues: extractHealthIssues(payload.checks),
            generatedAt: payload.generatedAt || null,
            error: null,
          });
        }
      } catch {
        setHealthDiagnostics({
          status: 'unknown',
          summary: null,
          issues: [],
          generatedAt: null,
          error: 'Health response parsing failed.',
        });
      }
    } else {
      setHealthDiagnostics({
        status: 'unknown',
        summary: null,
        issues: [],
        generatedAt: null,
        error: 'Health diagnostics request failed.',
      });
    }

    if (doctorResult.status === 'fulfilled') {
      try {
        const payload = (await doctorResult.value.json()) as DoctorApiResponse;
        if (!doctorResult.value.ok || payload.ok === false) {
          setDoctorDiagnostics({
            status: 'unknown',
            findingsCount: 0,
            recommendationsCount: 0,
            findingDetails: [],
            recommendations: [],
            generatedAt: null,
            error: payload.error || 'Doctor endpoint is not accessible.',
          });
        } else {
          setDoctorDiagnostics({
            status: parseDiagnosticsStatus(payload.status),
            findingsCount: Array.isArray(payload.findings) ? payload.findings.length : 0,
            recommendationsCount: Array.isArray(payload.recommendations)
              ? payload.recommendations.length
              : 0,
            findingDetails: extractDoctorFindingDetails(payload.findings),
            recommendations: Array.isArray(payload.recommendations)
              ? payload.recommendations.slice(0, 3)
              : [],
            generatedAt: payload.generatedAt || null,
            error: null,
          });
        }
      } catch {
        setDoctorDiagnostics({
          status: 'unknown',
          findingsCount: 0,
          recommendationsCount: 0,
          findingDetails: [],
          recommendations: [],
          generatedAt: null,
          error: 'Doctor response parsing failed.',
        });
      }
    } else {
      setDoctorDiagnostics({
        status: 'unknown',
        findingsCount: 0,
        recommendationsCount: 0,
        findingDetails: [],
        recommendations: [],
        generatedAt: null,
        error: 'Doctor diagnostics request failed.',
      });
    }

    setDiagnosticsLoading(false);
  }, []);

  useEffect(() => {
    void fetchDiagnostics();
  }, [fetchDiagnostics]);

  useEffect(() => {
    const interval = setInterval(() => {
      void fetchDiagnostics();
    }, 30000);

    return () => clearInterval(interval);
  }, [fetchDiagnostics]);

  // ── WebSocket real-time stream ───────────────────────────────

  useEffect(() => {
    const client = getGatewayClient();
    client.connect();

    // Subscribe to log events on the server
    client.request('logs.subscribe', {}).catch(() => {});

    const unsubState = client.onStateChange((state) => {
      setIsConnected(state === 'connected');
    });

    const unsub = client.on('log.entry', (payload) => {
      try {
        const entry = payload as LogEntry;
        setLogs((prev) => {
          const next = [...prev, entry];
          return next.length > 1000 ? next.slice(-1000) : next;
        });
        setTotalCount((c) => c + 1);

        setSources((prev) => {
          if (!prev.includes(entry.source)) {
            return [...prev, entry.source].sort();
          }
          return prev;
        });

        setCategories((prev) => {
          if (!prev.includes(entry.category)) {
            return [...prev, entry.category].sort();
          }
          return prev;
        });
      } catch { /* Invalid event data */ }
    });

    // Set connected if already connected
    if (client.state === 'connected') setIsConnected(true);

    return () => {
      unsub();
      unsubState();
      client.request('logs.unsubscribe', {}).catch(() => {});
      setIsConnected(false);
    };
  }, []);

  // ── Auto-scroll ────────────────────────────────────────────

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 40;
    setAutoScroll(isAtBottom);
  }, []);

  // ── Actions ────────────────────────────────────────────────

  const handleClear = useCallback(async () => {
    try {
      await fetch('/api/logs', { method: 'DELETE' });
      setLogs([]);
      setTotalCount(0);
    } catch {
      // Silently fail
    }
  }, []);

  const handleExport = useCallback(() => {
    const dataStr = JSON.stringify(logs, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `system-logs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [logs]);

  const handleCopyLog = useCallback((log: LogEntry) => {
    const text = `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.source}: ${log.message}`;
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(log.id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  }, []);

  // ── Filtered logs ──────────────────────────────────────────

  const filteredLogs = logs.filter((l) => {
    if (levelFilter !== 'all' && l.level !== levelFilter) return false;
    if (sourceFilter !== 'all' && l.source !== sourceFilter) return false;
    if (categoryFilter !== 'all' && l.category !== categoryFilter) return false;
    if (search && !l.message.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // ── Level counts ───────────────────────────────────────────

  const levelCounts = logs.reduce(
    (acc, l) => {
      acc[l.level] = (acc[l.level] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full space-y-4 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight flex items-center space-x-3">
            <span>System Logs</span>
            <span className={`inline-flex items-center space-x-1.5 text-[10px] font-bold px-2.5 py-1 rounded-full border ${
              isConnected
                ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
                : 'text-zinc-500 border-zinc-700 bg-zinc-800'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-600'}`} />
              <span>{isConnected ? 'LIVE' : 'OFFLINE'}</span>
            </span>
          </h2>
          <p className="text-sm text-zinc-500 mt-0.5">
            Real-time telemetry and bridge activity stream.
            {totalCount > 0 && (
              <span className="ml-2 text-zinc-600">
                {totalCount.toLocaleString()} total entries
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Diagnostics Summary */}
      <div className="bg-zinc-950/70 border border-zinc-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-black tracking-wide uppercase text-zinc-200">
              System Diagnostics
            </h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              Quick view of Health and Doctor checks.
            </p>
          </div>
          <button
            onClick={() => void fetchDiagnostics()}
            className="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wide bg-zinc-900/80 border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700 transition-colors"
          >
            {diagnosticsLoading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(() => {
            const config = DIAGNOSTIC_STATUS_CONFIG[healthDiagnostics.status];
            return (
              <div className={`rounded-lg border p-3 ${config.borderClass} ${config.bgClass}`}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black uppercase tracking-wide text-zinc-200">Health</span>
                  <span className={`text-[10px] font-black px-2 py-0.5 rounded border ${config.textClass} ${config.borderClass}`}>
                    {config.label}
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-2 mt-2 text-[11px]">
                  <div className="rounded bg-black/30 px-2 py-1">
                    <div className="text-zinc-500 uppercase">OK</div>
                    <div className="text-zinc-200 font-bold">{healthDiagnostics.summary?.ok ?? 0}</div>
                  </div>
                  <div className="rounded bg-black/30 px-2 py-1">
                    <div className="text-zinc-500 uppercase">Warn</div>
                    <div className="text-zinc-200 font-bold">{healthDiagnostics.summary?.warning ?? 0}</div>
                  </div>
                  <div className="rounded bg-black/30 px-2 py-1">
                    <div className="text-zinc-500 uppercase">Crit</div>
                    <div className="text-zinc-200 font-bold">{healthDiagnostics.summary?.critical ?? 0}</div>
                  </div>
                  <div className="rounded bg-black/30 px-2 py-1">
                    <div className="text-zinc-500 uppercase">Skip</div>
                    <div className="text-zinc-200 font-bold">{healthDiagnostics.summary?.skipped ?? 0}</div>
                  </div>
                </div>
                <div className="mt-2 text-[10px] text-zinc-500">
                  {healthDiagnostics.error
                    ? healthDiagnostics.error
                    : healthDiagnostics.generatedAt
                      ? `Updated ${relativeTime(healthDiagnostics.generatedAt)}`
                      : 'No health snapshot yet.'}
                </div>
                <div className="mt-2 rounded border border-zinc-800/80 bg-black/30 px-2 py-1.5">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">
                    Current Warnings
                  </div>
                  {healthDiagnostics.issues.length === 0 ? (
                    <div className="mt-1 text-[11px] text-zinc-400">No active warnings</div>
                  ) : (
                    <div className="mt-1 space-y-1">
                      {healthDiagnostics.issues.map((issue, index) => (
                        <div key={`${issue}-${index}`} className="text-[11px] text-amber-300 break-words">
                          {issue}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {(() => {
            const config = DIAGNOSTIC_STATUS_CONFIG[doctorDiagnostics.status];
            return (
              <div className={`rounded-lg border p-3 ${config.borderClass} ${config.bgClass}`}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black uppercase tracking-wide text-zinc-200">Doctor</span>
                  <span className={`text-[10px] font-black px-2 py-0.5 rounded border ${config.textClass} ${config.borderClass}`}>
                    {config.label}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-2 text-[11px]">
                  <div className="rounded bg-black/30 px-2 py-1">
                    <div className="text-zinc-500 uppercase">Findings</div>
                    <div className="text-zinc-200 font-bold">{doctorDiagnostics.findingsCount}</div>
                  </div>
                  <div className="rounded bg-black/30 px-2 py-1">
                    <div className="text-zinc-500 uppercase">Recommendations</div>
                    <div className="text-zinc-200 font-bold">{doctorDiagnostics.recommendationsCount}</div>
                  </div>
                </div>
                <div className="mt-2 text-[10px] text-zinc-500">
                  {doctorDiagnostics.error
                    ? doctorDiagnostics.error
                    : doctorDiagnostics.generatedAt
                      ? `Updated ${relativeTime(doctorDiagnostics.generatedAt)}`
                      : 'No doctor snapshot yet.'}
                </div>
                <div className="mt-2 rounded border border-zinc-800/80 bg-black/30 px-2 py-1.5">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">
                    Finding Details
                  </div>
                  {doctorDiagnostics.findingDetails.length === 0 ? (
                    <div className="mt-1 text-[11px] text-zinc-400">No active findings</div>
                  ) : (
                    <div className="mt-1 space-y-1">
                      {doctorDiagnostics.findingDetails.map((detail, index) => (
                        <div key={`${detail}-${index}`} className="text-[11px] text-amber-300 break-words">
                          {detail}
                        </div>
                      ))}
                    </div>
                  )}
                  {doctorDiagnostics.recommendations.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-zinc-800/80">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">
                        Top Recommendation
                      </div>
                      <div className="mt-1 text-[11px] text-zinc-300 break-words">
                        {doctorDiagnostics.recommendations[0]}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-4 gap-3">
        {(['info', 'warn', 'error', 'debug'] as const).map((level) => {
          const config = LEVEL_CONFIG[level];
          const count = levelCounts[level] || 0;
          return (
            <button
              key={level}
              onClick={() => setLevelFilter((prev) => (prev === level ? 'all' : level))}
              className={`px-4 py-2.5 rounded-lg border transition-all text-left group ${
                levelFilter === level
                  ? `${config.bg} ${config.badge} border`
                  : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700'
              }`}
            >
              <div className={`text-[10px] font-black uppercase tracking-widest ${config.color}`}>
                {level}
              </div>
              <div className="text-lg font-bold text-white">{count}</div>
            </button>
          );
        })}
      </div>

      {/* Toolbar */}
      <div className="flex items-center space-x-2">
        {/* Search */}
        <div className="flex-1 relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            placeholder="Search logs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-zinc-900/80 text-sm text-zinc-300 pl-10 pr-4 py-2 rounded-lg border border-zinc-800 focus:outline-none focus:border-zinc-600 placeholder-zinc-600 transition-colors"
          />
        </div>

        {/* Level Filter */}
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value as LevelFilter)}
          className="bg-zinc-900/80 text-xs font-bold text-zinc-300 px-3 py-2 rounded-lg border border-zinc-800 focus:outline-none focus:border-zinc-600 transition-colors cursor-pointer"
        >
          <option value="all">ALL LEVELS</option>
          <option value="info">INFO</option>
          <option value="warn">WARNINGS</option>
          <option value="error">ERRORS</option>
          <option value="debug">DEBUG</option>
        </select>

        {/* Source Filter */}
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="bg-zinc-900/80 text-xs font-bold text-zinc-300 px-3 py-2 rounded-lg border border-zinc-800 focus:outline-none focus:border-zinc-600 transition-colors cursor-pointer"
        >
          <option value="all">ALL SOURCES</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="bg-zinc-900/80 text-xs font-bold text-zinc-300 px-3 py-2 rounded-lg border border-zinc-800 focus:outline-none focus:border-zinc-600 transition-colors cursor-pointer"
        >
          <option value="all">ALL CATEGORIES</option>
          {categories.map((category) => (
            <option key={category} value={category}>
              {category.toUpperCase()}
            </option>
          ))}
        </select>

        {/* Auto-scroll toggle */}
        <button
          onClick={() => {
            setAutoScroll(!autoScroll);
            if (!autoScroll && scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
          }}
          className={`px-3 py-2 rounded-lg text-xs font-bold transition-all border ${
            autoScroll
              ? 'bg-violet-500/10 border-violet-500/30 text-violet-400'
              : 'bg-zinc-900/80 border-zinc-800 text-zinc-500 hover:text-zinc-300'
          }`}
          title={autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </button>

        {/* Export */}
        <button
          onClick={handleExport}
          disabled={logs.length === 0}
          className="px-3 py-2 bg-zinc-900/80 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 rounded-lg text-xs font-bold transition-all border border-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
          title="Export as JSON"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        </button>

        {/* Clear */}
        <button
          onClick={handleClear}
          disabled={logs.length === 0}
          className="px-4 py-2 bg-zinc-900/80 hover:bg-rose-500/10 text-zinc-400 hover:text-rose-400 rounded-lg text-xs font-bold transition-all uppercase border border-zinc-800 hover:border-rose-500/30 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Clear
        </button>
      </div>

      {/* Log Table */}
      <div className="flex-1 bg-black/50 border border-zinc-800 rounded-xl overflow-hidden flex flex-col font-mono text-xs shadow-2xl">
        {/* Table Header */}
        <div className="bg-zinc-900/60 px-4 py-2.5 border-b border-zinc-800 flex items-center text-zinc-500 uppercase font-black tracking-tighter select-none shrink-0">
          <span className="w-20 shrink-0">Time</span>
          <span className="w-16 shrink-0">Level</span>
          <span className="w-24 shrink-0">Source</span>
          <span className="flex-1">Message</span>
          <span className="w-20 shrink-0 text-right">Age</span>
        </div>

        {/* Log Rows */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto"
        >
          {isLoading ? (
            <div className="h-full flex items-center justify-center">
              <div className="flex items-center space-x-3 text-zinc-600">
                <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span className="text-xs font-bold uppercase">Loading logs...</span>
              </div>
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-12">
              <svg className="w-12 h-12 text-zinc-800 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="text-sm text-zinc-700 font-bold">No log entries</span>
              <span className="text-[10px] text-zinc-800 mt-1 uppercase font-bold tracking-wider">
                {search || levelFilter !== 'all' || sourceFilter !== 'all'
                  ? 'Try adjusting your filters'
                  : 'Waiting for system activity...'}
              </span>
            </div>
          ) : (
            <div className="divide-y divide-zinc-900/50">
              {filteredLogs.map((log) => {
                const config = LEVEL_CONFIG[log.level] || LEVEL_CONFIG.info;
                const sourceColor = SOURCE_COLORS[log.source] || 'text-indigo-400';

                return (
                  <div
                    key={log.id}
                    onClick={() => handleCopyLog(log)}
                    className={`flex items-start px-4 py-1.5 group cursor-pointer transition-colors hover:bg-zinc-900/50 ${
                      log.level === 'error' ? 'bg-rose-500/[0.03]' : ''
                    }`}
                    title="Click to copy"
                  >
                    <span className="w-20 shrink-0 text-zinc-600 tabular-nums">
                      {formatTimestamp(log.timestamp)}
                    </span>
                    <span
                      className={`w-16 shrink-0 font-black ${config.color}`}
                    >
                      [{log.level.toUpperCase()}]
                    </span>
                    <span className={`w-24 shrink-0 font-bold ${sourceColor}`}>
                      {log.source}
                    </span>
                    <span className="flex-1 text-zinc-400 group-hover:text-zinc-200 transition-colors break-all">
                      <span className="text-zinc-600 mr-2">[{log.category}]</span>
                      {log.message}
                    </span>
                    <span className="w-20 shrink-0 text-right text-zinc-700 tabular-nums">
                      {copiedId === log.id ? (
                        <span className="text-emerald-500 font-bold">Copied!</span>
                      ) : (
                        relativeTime(log.createdAt)
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Status Bar */}
        <div className="bg-zinc-900/60 px-4 py-1.5 border-t border-zinc-800 flex items-center justify-between text-[10px] text-zinc-600 font-mono uppercase shrink-0">
          <div className="flex items-center space-x-4">
            <span>{filteredLogs.length} entries shown</span>
            {filteredLogs.length !== logs.length && (
              <span className="text-zinc-700">({logs.length} total loaded)</span>
            )}
          </div>
          <div className="flex items-center space-x-4">
            {autoScroll && (
              <span className="flex items-center space-x-1 text-violet-500">
                <span className="w-1 h-1 rounded-full bg-violet-500 animate-pulse" />
                <span>Auto-scroll</span>
              </span>
            )}
            <span className={isConnected ? 'text-emerald-600' : 'text-zinc-700'}>
              WS {isConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LogsView;
