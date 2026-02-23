export interface LogEntry {
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

export type LevelFilter = 'all' | 'debug' | 'info' | 'warn' | 'error';
export type DiagnosticsStatus = 'ok' | 'degraded' | 'critical' | 'unknown';
export const DIAGNOSTICS_REFRESH_INTERVAL_MS = 180000;
export const MEMORY_DIAGNOSTICS_STORAGE_KEY = 'openclaw-memory-diagnostics-enabled';

export interface HealthSummary {
  ok: number;
  warning: number;
  critical: number;
  skipped: number;
}

export interface HealthDiagnosticsState {
  status: DiagnosticsStatus;
  summary: HealthSummary | null;
  issues: string[];
  generatedAt: string | null;
  error: string | null;
}

export interface DoctorDiagnosticsState {
  status: DiagnosticsStatus;
  findingsCount: number;
  recommendationsCount: number;
  findingDetails: string[];
  recommendations: string[];
  generatedAt: string | null;
  error: string | null;
}

export interface HealthCheckSnapshot {
  id?: unknown;
  status?: unknown;
  message?: unknown;
}

export interface DoctorFindingSnapshot {
  severity?: unknown;
  title?: unknown;
  detail?: unknown;
}

export interface HealthApiResponse {
  ok?: boolean;
  status?: 'ok' | 'degraded' | 'critical';
  summary?: HealthSummary;
  checks?: HealthCheckSnapshot[];
  generatedAt?: string;
  error?: string;
}

export interface DoctorApiResponse {
  ok?: boolean;
  status?: 'ok' | 'degraded' | 'critical';
  checks?: HealthCheckSnapshot[];
  findings?: DoctorFindingSnapshot[];
  recommendations?: string[];
  generatedAt?: string;
  error?: string;
}

type DiagnosticsIssueSeverity = 'warning' | 'critical';

export interface HealthIssueInsight {
  code: string;
  rawMessage: string;
  severity: DiagnosticsIssueSeverity;
  title: string;
  meaning: string;
  action: string;
}

export function relativeTime(iso: string): string {
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

export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export const LEVEL_CONFIG: Record<string, { color: string; bg: string; badge: string }> = {
  debug: { color: 'text-zinc-400', bg: 'bg-zinc-500/10', badge: 'border-zinc-600' },
  info: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', badge: 'border-emerald-500/40' },
  warn: { color: 'text-amber-400', bg: 'bg-amber-500/10', badge: 'border-amber-500/40' },
  error: { color: 'text-rose-400', bg: 'bg-rose-500/10', badge: 'border-rose-500/40' },
};

export const SOURCE_COLORS: Record<string, string> = {
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

export const DIAGNOSTIC_STATUS_CONFIG: Record<
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

export function parseDiagnosticsStatus(value: unknown): DiagnosticsStatus {
  if (value === 'ok' || value === 'degraded' || value === 'critical') {
    return value;
  }
  return 'unknown';
}

type HealthCheckStatusSnapshot = keyof HealthSummary;

function parseHealthCheckStatus(value: unknown): HealthCheckStatusSnapshot | null {
  if (value === 'ok' || value === 'warning' || value === 'critical' || value === 'skipped') {
    return value;
  }
  return null;
}

export function summarizeHealthChecks(checks: HealthCheckSnapshot[] | undefined): HealthSummary | null {
  if (!Array.isArray(checks)) return null;

  const summary: HealthSummary = { ok: 0, warning: 0, critical: 0, skipped: 0 };
  let recognized = 0;

  for (const check of checks) {
    const status = parseHealthCheckStatus(check?.status);
    if (!status) continue;
    summary[status] += 1;
    recognized += 1;
  }

  return recognized > 0 ? summary : null;
}

export function toHealthDiagnosticsStatus(summary: HealthSummary | null): DiagnosticsStatus {
  if (!summary) return 'unknown';
  if (summary.critical > 0) return 'critical';
  if (summary.warning > 0) return 'degraded';
  return 'ok';
}

const HEALTH_ISSUE_HINTS: Record<
  string,
  Pick<HealthIssueInsight, 'title' | 'meaning' | 'action'>
> = {
  'security.snapshot': {
    title: 'Security-Check hat Warnungen',
    meaning: 'Sicherheitsregeln oder Secrets sind nicht vollständig abgesichert.',
    action: 'Open `/api/security/status` and resolve warning entries.',
  },
  'diagnostics.memory_pressure': {
    title: 'Arbeitsspeicher ist fast voll',
    meaning: 'Der Arbeitsspeicher (Node-Heap) ist nahe am Limit und kann instabil werden.',
    action: 'Inaktive Sessions reduzieren, Last senken und Prozess bei Bedarf neu starten.',
  },
  'diagnostics.error_budget': {
    title: 'Fehlerquote zu hoch',
    meaning: 'Zu viele Fehler im Zeitfenster deuten auf ein akutes Incident-Risiko hin.',
    action: 'Error-Logs korrelieren, letzte Aenderungen pruefen und Rollback erwägen.',
  },
  'integration.whatsapp_bridge': {
    title: 'WhatsApp-Integration gestoert',
    meaning: 'Die Bridge ist erreichbar, meldet aber Fehler oder Timeouts.',
    action: 'Bridge-Service und Credentials pruefen, danach Health neu laden.',
  },
  'integration.imessage_bridge': {
    title: 'iMessage-Integration gestoert',
    meaning: 'Die Bridge ist erreichbar, meldet aber Fehler oder Timeouts.',
    action: 'Bridge-Service und Credentials pruefen, danach Health neu laden.',
  },
};

function normalizeIssueMessage(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function resolveIssueSeverity(message: string): DiagnosticsIssueSeverity {
  const normalized = message.toLowerCase();
  if (normalized.includes('critical')) {
    return 'critical';
  }
  return 'warning';
}

export function toHealthIssueInsight(issue: string): HealthIssueInsight {
  const separator = issue.indexOf(':');
  const code = separator > 0 ? issue.slice(0, separator).trim() : 'unknown.check';
  const rawMessage = normalizeIssueMessage(separator > 0 ? issue.slice(separator + 1) : issue);
  const severity = resolveIssueSeverity(rawMessage);

  const hint = HEALTH_ISSUE_HINTS[code] ?? {
    title: 'Diagnose-Check auffaellig',
    meaning: 'Ein Diagnose-Check hat eine Warnung oder einen kritischen Status gemeldet.',
    action:
      'Details im Health-Report pruefen (`/api/health`) und Logs auf zusammenhaengende Fehler filtern.',
  };

  return {
    code,
    rawMessage,
    severity,
    title: hint.title,
    meaning: hint.meaning,
    action: hint.action,
  };
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
      const detail = typeof finding.detail === 'string' ? finding.detail : 'No details available.';
      return `${title}: ${detail}`;
    })
    .slice(0, limit);
}
