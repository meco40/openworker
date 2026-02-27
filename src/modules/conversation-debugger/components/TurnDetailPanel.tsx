import React from 'react';
import type { DebugTurn } from '../types';
import { CollapsibleSection, RiskBadge, Badge, StatRow, TokenBar } from './ui-helpers';

interface TurnDetailPanelProps {
  turn: DebugTurn | null;
  onReplayFrom: (seq: number) => void;
}

// ─── Tool Call Card ───────────────────────────────────────────────────────────

interface ToolCallCardProps {
  name: string;
  args: Record<string, unknown> | null | undefined;
  index: number;
}

const ToolCallCard: React.FC<ToolCallCardProps> = ({ name, args, index }) => {
  const [expanded, setExpanded] = React.useState(false);
  const hasArgs = args != null && Object.keys(args).length > 0;
  const argsStr = hasArgs ? JSON.stringify(args, null, 2) : null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
        aria-expanded={expanded}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-violet-900/60 font-mono text-[9px] text-violet-400">
          {index + 1}
        </span>
        <span className="flex-1 truncate font-mono text-xs text-violet-300">{name}</span>
        {hasArgs && (
          <span className="shrink-0 text-[10px] text-zinc-600" aria-hidden="true">
            {expanded ? '▲' : '▼'}
          </span>
        )}
      </button>
      {expanded && argsStr && (
        <pre className="border-t border-zinc-800 px-3 py-2 font-mono text-[10px] leading-relaxed break-all whitespace-pre-wrap text-zinc-500">
          {argsStr}
        </pre>
      )}
    </div>
  );
};

// ─── Content Block ────────────────────────────────────────────────────────────

interface ContentBlockProps {
  content: string;
  role: 'user' | 'assistant' | 'memory';
}

const ROLE_STYLES: Record<ContentBlockProps['role'], string> = {
  user: 'border-zinc-700/50 bg-zinc-800/30 text-zinc-300',
  assistant: 'border-blue-900/40 bg-blue-950/20 text-zinc-300',
  memory: 'border-teal-900/40 bg-teal-950/20 text-zinc-400',
};

const ContentBlock: React.FC<ContentBlockProps> = ({ content, role }) => (
  <div
    className={`rounded-lg border px-3 py-2.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap ${ROLE_STYLES[role]}`}
  >
    {content}
  </div>
);

// ─── Main Component ───────────────────────────────────────────────────────────

const TurnDetailPanel: React.FC<TurnDetailPanelProps> = ({ turn, onReplayFrom }) => {
  if (!turn) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <span className="text-3xl" aria-hidden="true">
          ↖
        </span>
        <p className="text-sm font-medium text-zinc-500">Select a turn to inspect it</p>
        <p className="max-w-xs text-xs text-zinc-700">
          Click any turn in the timeline to view its prompt, response, tool calls, and metadata.
        </p>
      </div>
    );
  }

  const totalTokens = (turn.promptTokens ?? 0) + (turn.completionTokens ?? 0);

  return (
    <div className="flex h-full flex-col gap-0 overflow-auto text-xs">
      {/* ── Turn Header ─────────────────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-zinc-800/60 pb-3">
        <span className="rounded-lg bg-blue-900/40 px-2.5 py-1 font-mono text-sm font-bold text-blue-300">
          T{turn.seq}
        </span>

        <RiskBadge level={turn.riskLevel} />

        {turn.modelName && (
          <Badge variant="zinc" className="max-w-[200px] truncate">
            {turn.modelName}
          </Badge>
        )}

        {turn.latencyMs != null && (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-zinc-500">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-3 w-3 text-zinc-600"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 000-1.5h-3.25V5z"
                clipRule="evenodd"
              />
            </svg>
            {turn.latencyMs}ms
          </span>
        )}
      </div>

      {/* ── Metadata ────────────────────────────────────────────────────── */}
      <div className="mb-4">
        <CollapsibleSection title="Metadata">
          <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-2">
            <StatRow label="Turn" value={`#${String(turn.seq)}`} mono />
            {turn.dispatchId && <StatRow label="Dispatch ID" value={turn.dispatchId} mono />}
            {turn.modelName && <StatRow label="Model" value={turn.modelName} />}
            {turn.latencyMs != null && (
              <StatRow label="Latency" value={`${String(turn.latencyMs)}ms`} mono />
            )}
            <StatRow label="Risk" value={(turn.riskLevel ?? 'low').toUpperCase()} />
          </div>
        </CollapsibleSection>
      </div>

      {/* ── Token Usage ─────────────────────────────────────────────────── */}
      {totalTokens > 0 && (
        <div className="mb-4">
          <CollapsibleSection title="Token Usage">
            <TokenBar
              promptTokens={turn.promptTokens ?? 0}
              completionTokens={turn.completionTokens ?? 0}
            />
          </CollapsibleSection>
        </div>
      )}

      {/* ── User Message ────────────────────────────────────────────────── */}
      {turn.userPreview && (
        <div className="mb-4">
          <CollapsibleSection title="User Message">
            <ContentBlock content={turn.userPreview} role="user" />
          </CollapsibleSection>
        </div>
      )}

      {/* ── Assistant Response ───────────────────────────────────────────── */}
      {turn.assistantPreview && (
        <div className="mb-4">
          <CollapsibleSection title="Assistant Response">
            <ContentBlock content={turn.assistantPreview} role="assistant" />
          </CollapsibleSection>
        </div>
      )}

      {/* ── Tool Calls ──────────────────────────────────────────────────── */}
      {turn.toolCalls && turn.toolCalls.length > 0 && (
        <div className="mb-4">
          <CollapsibleSection
            title="Tool Calls"
            badge={
              <Badge variant="violet">{turn.toolCalls.length}</Badge>
            }
          >
            <div className="flex flex-col gap-1.5">
              {turn.toolCalls.map((tc, i) => (
                <ToolCallCard key={i} name={tc.name} args={tc.args} index={i} />
              ))}
            </div>
          </CollapsibleSection>
        </div>
      )}

      {/* ── Memory Context ───────────────────────────────────────────────── */}
      {turn.memoryContext && (
        <div className="mb-4">
          <CollapsibleSection title="Memory Context" defaultOpen={false}>
            <ContentBlock content={turn.memoryContext} role="memory" />
          </CollapsibleSection>
        </div>
      )}

      {/* ── Replay CTA ──────────────────────────────────────────────────── */}
      <div className="mt-auto pt-4">
        <button
          type="button"
          onClick={() => onReplayFrom(turn.seq)}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M2 10a8 8 0 1116 0 8 8 0 01-16 0zm6.39-2.908a.75.75 0 01.766.027l3.5 2.25a.75.75 0 010 1.262l-3.5 2.25A.75.75 0 018 12.25v-4.5a.75.75 0 01.39-.658z"
              clipRule="evenodd"
            />
          </svg>
          Re-run from Turn {turn.seq}
        </button>
      </div>
    </div>
  );
};

export default TurnDetailPanel;
