/**
 * Local UI helper components for the Conversation Debugger module.
 * These are small, reusable building blocks used across the debugger views.
 */
import React from 'react';

// ─── Loading Spinner ─────────────────────────────────────────────────────────

export const Spinner: React.FC<{ size?: 'sm' | 'md' }> = ({ size = 'md' }) => {
  const dim = size === 'sm' ? 'h-4 w-4' : 'h-6 w-6';
  return (
    <svg
      className={`${dim} animate-spin text-zinc-400`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
};

// ─── Empty State ─────────────────────────────────────────────────────────────

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, description, action }) => (
  <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
    {icon && <div className="mb-1 text-zinc-600">{icon}</div>}
    <p className="text-sm font-medium text-zinc-400">{title}</p>
    {description && <p className="max-w-xs text-xs text-zinc-600">{description}</p>}
    {action && <div className="mt-1">{action}</div>}
  </div>
);

// ─── Error Banner ─────────────────────────────────────────────────────────────

interface ErrorBannerProps {
  message: string;
  onRetry?: () => void;
  compact?: boolean;
}

export const ErrorBanner: React.FC<ErrorBannerProps> = ({ message, onRetry, compact = false }) => (
  <div
    className={`flex items-start gap-2 rounded-lg border border-red-800/60 bg-red-950/30 text-red-400 ${
      compact ? 'px-2 py-1.5 text-[11px]' : 'px-3 py-2.5 text-xs'
    }`}
    role="alert"
  >
    <span className="mt-px shrink-0 text-red-500" aria-hidden="true">
      ⚠
    </span>
    <span className="flex-1 leading-relaxed">{message}</span>
    {onRetry && (
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 underline hover:text-red-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-red-400"
      >
        Retry
      </button>
    )}
  </div>
);

// ─── Section Header (collapsible) ────────────────────────────────────────────

interface SectionProps {
  title: string;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export const CollapsibleSection: React.FC<SectionProps> = ({
  title,
  badge,
  defaultOpen = true,
  children,
}) => {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className="border-b border-zinc-800/70 pb-3 last:border-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mb-2 flex w-full items-center gap-2 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
        aria-expanded={open}
      >
        <span
          className="text-[10px] text-zinc-600 transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
          aria-hidden="true"
        >
          ▶
        </span>
        <span className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">{title}</span>
        {badge && <span className="ml-1">{badge}</span>}
      </button>
      {open && <div className="pl-4">{children}</div>}
    </div>
  );
};

// ─── Stat Row ─────────────────────────────────────────────────────────────────

interface StatRowProps {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}

export const StatRow: React.FC<StatRowProps> = ({ label, value, mono = false }) => (
  <div className="flex items-baseline justify-between gap-2 py-0.5">
    <span className="shrink-0 text-[11px] text-zinc-500">{label}</span>
    <span className={`text-right text-[11px] text-zinc-300 ${mono ? 'font-mono' : ''}`}>
      {value}
    </span>
  </div>
);

// ─── Badge ────────────────────────────────────────────────────────────────────

type BadgeVariant = 'default' | 'blue' | 'violet' | 'teal' | 'red' | 'amber' | 'emerald' | 'zinc';

const BADGE_CLASSES: Record<BadgeVariant, string> = {
  default: 'bg-zinc-700/80 text-zinc-300',
  blue: 'bg-blue-900/60 text-blue-300',
  violet: 'bg-violet-900/60 text-violet-300',
  teal: 'bg-teal-900/60 text-teal-300',
  red: 'bg-red-900/60 text-red-300',
  amber: 'bg-amber-900/60 text-amber-300',
  emerald: 'bg-emerald-900/60 text-emerald-300',
  zinc: 'bg-zinc-800 text-zinc-400',
};

interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  title?: string;
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  variant = 'default',
  children,
  title,
  className = '',
}) => (
  <span
    className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] leading-none font-medium ${BADGE_CLASSES[variant]} ${className}`}
    title={title}
  >
    {children}
  </span>
);

// ─── Risk Badge ───────────────────────────────────────────────────────────────

export const RiskBadge: React.FC<{ level: string | undefined }> = ({ level }) => {
  const upper = (level ?? 'low').toUpperCase();
  if (upper === 'HIGH') return <Badge variant="red">HIGH RISK</Badge>;
  if (upper === 'MEDIUM') return <Badge variant="amber">MEDIUM RISK</Badge>;
  return <Badge variant="emerald">LOW RISK</Badge>;
};

export function riskDotClass(level: string | undefined): string {
  const upper = (level ?? 'low').toUpperCase();
  if (upper === 'HIGH') return 'bg-red-500';
  if (upper === 'MEDIUM') return 'bg-amber-400';
  return 'bg-emerald-500';
}

// ─── Relative Time ────────────────────────────────────────────────────────────

export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

// ─── Token Bar ────────────────────────────────────────────────────────────────

interface TokenBarProps {
  promptTokens: number;
  completionTokens: number;
}

export const TokenBar: React.FC<TokenBarProps> = ({ promptTokens, completionTokens }) => {
  const total = promptTokens + completionTokens;
  if (total === 0) return null;
  const promptPct = Math.round((promptTokens / total) * 100);
  return (
    <div>
      <div
        className="mb-1.5 flex h-2.5 overflow-hidden rounded-full bg-zinc-800"
        role="img"
        aria-label={`Token usage: ${String(promptTokens)} prompt, ${String(completionTokens)} completion`}
      >
        <div
          className="h-full bg-blue-600 transition-all"
          style={{ width: `${String(promptPct)}%` }}
        />
        <div className="h-full flex-1 bg-violet-500" />
      </div>
      <div className="flex gap-4 text-[11px] text-zinc-500">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-blue-600" aria-hidden="true" />
          Prompt {promptTokens.toLocaleString()}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-violet-500" aria-hidden="true" />
          Completion {completionTokens.toLocaleString()}
        </span>
        <span className="ml-auto text-zinc-600">{total.toLocaleString()} total</span>
      </div>
    </div>
  );
};

// ─── Kbd shortcut hint ────────────────────────────────────────────────────────

export const KbdHint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 font-mono text-[10px] text-zinc-500">
    {children}
  </kbd>
);
