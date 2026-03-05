'use client';

import React from 'react';
import type { AutonomousConfigSectionProps } from '../types';
import { TOOL_CALLS_CONFIG } from '../constants';

export function AutonomousConfigSection({
  isAutonomous,
  maxToolCalls,
  onIsAutonomousChange,
  onMaxToolCallsChange,
  savingAutonomous,
  readOnly = false,
  readOnlyMessage,
}: AutonomousConfigSectionProps) {
  return (
    <div className="space-y-4 border-t border-zinc-800 pt-6">
      <div className="space-y-1">
        <h4 className="text-lg font-bold text-white">Autonomer Agenten-Modus</h4>
        <p className="text-sm text-zinc-400">
          Im autonomen Modus kann die Persona eigenständig Tool-Ketten ausführen, ohne nach jeder
          Tool-Runde um Erlaubnis zu fragen. Nützlich für System-Admin-, DevOps- und Build-Personas.
        </p>
      </div>

      {/* Toggle */}
      <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-zinc-200">Autonomer Modus</p>
          <p className="text-xs text-zinc-500">
            Persona benutzt immer ihr eigenes Tool-Budget ohne Limit-Check
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isAutonomous}
          disabled={readOnly || savingAutonomous}
          onClick={() => onIsAutonomousChange(!isAutonomous)}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
            isAutonomous ? 'bg-violet-600' : 'bg-zinc-700'
          }`}
        >
          <span
            aria-hidden="true"
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
              isAutonomous ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>
      {readOnlyMessage && <p className="text-xs text-amber-300/80">{readOnlyMessage}</p>}

      {/* Max Tool Calls — only visible when autonomous */}
      {isAutonomous && (
        <div className="space-y-2">
          <label htmlFor="persona-max-tool-calls" className="text-sm font-medium text-zinc-300">
            Maximale Tool-Aufrufe pro Antwort
          </label>
          <div className="flex items-center gap-3">
            <input
              id="persona-max-tool-calls"
              type="number"
              min={TOOL_CALLS_CONFIG.MIN}
              max={TOOL_CALLS_CONFIG.MAX}
              value={maxToolCalls}
              disabled={readOnly || savingAutonomous}
              onChange={(e) => {
                const val = Number(e.target.value);
                if (!Number.isNaN(val)) onMaxToolCallsChange(val);
              }}
              className="w-28 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:border-violet-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />
            <span className="text-xs text-zinc-500">
              Standard: {TOOL_CALLS_CONFIG.DEFAULT} · Min: {TOOL_CALLS_CONFIG.MIN} · Max:{' '}
              {TOOL_CALLS_CONFIG.MAX}
            </span>
          </div>
          <button
            onClick={() => onIsAutonomousChange(isAutonomous)}
            disabled={readOnly || savingAutonomous}
            className="rounded-lg bg-violet-600 px-4 py-1.5 text-xs font-bold tracking-wider text-white uppercase transition-all hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {savingAutonomous ? 'Speichern...' : 'Speichern'}
          </button>
        </div>
      )}
    </div>
  );
}
