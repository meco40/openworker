'use client';

import type { SwarmFriction } from '@/modules/agent-room/swarmTypes';

interface ConflictTabProps {
  friction: SwarmFriction | undefined;
}

export function ConflictTab({ friction }: ConflictTabProps) {
  if (!friction) {
    return <p className="pt-6 text-center text-zinc-600">No swarm selected.</p>;
  }

  const levelColorClass =
    friction.level === 'high'
      ? 'text-rose-400'
      : friction.level === 'medium'
        ? 'text-amber-400'
        : 'text-emerald-400';

  return (
    <div className="space-y-2 text-xs text-zinc-400">
      <div className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-950/40 p-2">
        <span>Friction Level</span>
        <span className={`font-semibold ${levelColorClass}`}>
          {(friction.level ?? 'low').toUpperCase()}
        </span>
      </div>

      <div className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-950/40 p-2">
        <span>Severity Score</span>
        <span className="font-semibold text-zinc-200">{friction.confidence ?? 0}/100</span>
      </div>

      {friction.reasons?.length > 0 && (
        <div className="rounded border border-zinc-800 bg-zinc-950/40 p-2">
          <div className="mb-1.5 font-semibold text-zinc-300">Detected Signals</div>
          <ul className="space-y-1.5">
            {friction.reasons.map((reason, i) => (
              <li
                key={i}
                className="rounded border border-zinc-800/50 bg-zinc-900/40 px-2 py-1 text-[11px] leading-relaxed text-zinc-400"
              >
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {friction.reasons?.length === 0 && (
        <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3 text-center text-zinc-500">
          No conflict signals detected in the current phase.
        </div>
      )}
    </div>
  );
}
