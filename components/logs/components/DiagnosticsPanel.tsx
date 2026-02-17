'use client';

import React from 'react';
import {
  DIAGNOSTIC_STATUS_CONFIG,
  toHealthIssueInsight,
  relativeTime,
  type HealthDiagnosticsState,
  type DoctorDiagnosticsState,
} from '../diagnostics';

interface DiagnosticsPanelProps {
  healthDiagnostics: HealthDiagnosticsState;
  doctorDiagnostics: DoctorDiagnosticsState;
  diagnosticsLoading: boolean;
  memoryDiagnosticsEnabled: boolean;
  onToggleMemoryDiagnostics: () => void;
  onRefresh: () => void;
}

export const DiagnosticsPanel: React.FC<DiagnosticsPanelProps> = ({
  healthDiagnostics,
  doctorDiagnostics,
  diagnosticsLoading,
  memoryDiagnosticsEnabled,
  onToggleMemoryDiagnostics,
  onRefresh,
}) => {
  const healthIssueInsights = healthDiagnostics.issues.map(toHealthIssueInsight);
  const healthConfig = DIAGNOSTIC_STATUS_CONFIG[healthDiagnostics.status];
  const doctorConfig = DIAGNOSTIC_STATUS_CONFIG[doctorDiagnostics.status];

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-black tracking-wide text-zinc-200 uppercase">
            System Diagnostics
          </h3>
          <p className="mt-0.5 text-xs text-zinc-500">Quick view of Health and Doctor checks.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleMemoryDiagnostics}
            className={`rounded-lg border px-3 py-1.5 text-[11px] font-bold tracking-wide uppercase transition-colors ${
              memoryDiagnosticsEnabled
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                : 'border-zinc-800 bg-zinc-900/80 text-zinc-500 hover:border-zinc-700 hover:text-zinc-200'
            }`}
            title={
              memoryDiagnosticsEnabled
                ? 'Detaillierte Memory-Diagnostik aktiv'
                : 'Detaillierte Memory-Diagnostik aus'
            }
          >
            Memory Profiling {memoryDiagnosticsEnabled ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={onRefresh}
            className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-1.5 text-[11px] font-bold tracking-wide text-zinc-400 uppercase transition-colors hover:border-zinc-700 hover:text-zinc-200"
          >
            {diagnosticsLoading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {/* Health Diagnostics */}
        <div
          className={`rounded-lg border p-3 ${healthConfig.borderClass} ${healthConfig.bgClass}`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-black tracking-wide text-zinc-200 uppercase">Health</span>
            <span
              className={`rounded border px-2 py-0.5 text-[10px] font-black ${healthConfig.textClass} ${healthConfig.borderClass}`}
            >
              {healthConfig.label}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-2 text-[11px]">
            <div className="rounded bg-black/30 px-2 py-1">
              <div className="text-zinc-500 uppercase">OK</div>
              <div className="font-bold text-zinc-200">{healthDiagnostics.summary?.ok ?? 0}</div>
            </div>
            <div className="rounded bg-black/30 px-2 py-1">
              <div className="text-zinc-500 uppercase">Warn</div>
              <div className="font-bold text-zinc-200">
                {healthDiagnostics.summary?.warning ?? 0}
              </div>
            </div>
            <div className="rounded bg-black/30 px-2 py-1">
              <div className="text-zinc-500 uppercase">Crit</div>
              <div className="font-bold text-zinc-200">
                {healthDiagnostics.summary?.critical ?? 0}
              </div>
            </div>
            <div className="rounded bg-black/30 px-2 py-1">
              <div className="text-zinc-500 uppercase">Skip</div>
              <div className="font-bold text-zinc-200">
                {healthDiagnostics.summary?.skipped ?? 0}
              </div>
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
            <div className="text-[10px] font-bold tracking-wide text-zinc-500 uppercase">
              Was Bedeutet Das?
            </div>
            {healthIssueInsights.length === 0 ? (
              <div className="mt-1 text-[11px] text-zinc-400">No active warnings</div>
            ) : (
              <div className="mt-1 space-y-1">
                {healthIssueInsights.map((issue, index) => (
                  <div
                    key={`${issue.code}-${index}`}
                    className="rounded border border-zinc-800/80 bg-black/40 px-2 py-1.5"
                  >
                    <div
                      className={`text-[11px] font-bold break-words ${
                        issue.severity === 'critical' ? 'text-rose-300' : 'text-amber-300'
                      }`}
                    >
                      {issue.code}: {issue.rawMessage}
                    </div>
                    <div className="mt-1 text-[11px] break-words text-zinc-300">
                      Bedeutung: {issue.meaning}
                    </div>
                    <div className="mt-0.5 text-[11px] break-words text-zinc-400">
                      Aktion: {issue.action}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Doctor Diagnostics */}
        <div
          className={`rounded-lg border p-3 ${doctorConfig.borderClass} ${doctorConfig.bgClass}`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-black tracking-wide text-zinc-200 uppercase">Doctor</span>
            <span
              className={`rounded border px-2 py-0.5 text-[10px] font-black ${doctorConfig.textClass} ${doctorConfig.borderClass}`}
            >
              {doctorConfig.label}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
            <div className="rounded bg-black/30 px-2 py-1">
              <div className="text-zinc-500 uppercase">Findings</div>
              <div className="font-bold text-zinc-200">{doctorDiagnostics.findingsCount}</div>
            </div>
            <div className="rounded bg-black/30 px-2 py-1">
              <div className="text-zinc-500 uppercase">Recommendations</div>
              <div className="font-bold text-zinc-200">
                {doctorDiagnostics.recommendationsCount}
              </div>
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
            <div className="text-[10px] font-bold tracking-wide text-zinc-500 uppercase">
              Finding Details
            </div>
            {doctorDiagnostics.findingDetails.length === 0 ? (
              <div className="mt-1 text-[11px] text-zinc-400">No active findings</div>
            ) : (
              <div className="mt-1 space-y-1">
                {doctorDiagnostics.findingDetails.map((detail, index) => (
                  <div
                    key={`${detail}-${index}`}
                    className="text-[11px] break-words text-amber-300"
                  >
                    {detail}
                  </div>
                ))}
              </div>
            )}
            {doctorDiagnostics.recommendations.length > 0 && (
              <div className="mt-2 border-t border-zinc-800/80 pt-2">
                <div className="text-[10px] font-bold tracking-wide text-zinc-500 uppercase">
                  Top Recommendation
                </div>
                <div className="mt-1 text-[11px] break-words text-zinc-300">
                  {doctorDiagnostics.recommendations[0]}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
