import React from 'react';

interface HeaderSectionProps {
  pipelineLength: number;
  providerCatalogLength: number;
  isProbing: boolean;
  isTestingAll: boolean;
  probeResult: string | null;
  lastProbeOk: boolean | null;
  bulkProbeSummary: string | null;
  onRunConnectionProbe: () => void;
  onRunAllConnectionProbes: () => void;
}

const HeaderSection: React.FC<HeaderSectionProps> = ({
  pipelineLength,
  providerCatalogLength,
  isProbing,
  isTestingAll,
  probeResult,
  lastProbeOk,
  bulkProbeSummary,
  onRunConnectionProbe,
  onRunAllConnectionProbes,
}) => {
  return (
    <div className="group relative flex flex-col justify-between gap-6 overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900/40 p-8 shadow-2xl md:flex-row md:items-center">
      <div className="absolute top-0 right-0 -mt-32 -mr-32 h-64 w-64 rounded-full bg-indigo-600/10 blur-3xl" />
      <div className="relative z-10">
        <div className="mb-2 flex items-center space-x-3">
          <h2 className="text-3xl font-black tracking-tight text-white uppercase">
            Gateway Control
          </h2>
          <div className="flex items-center space-x-2 rounded border border-zinc-800 bg-zinc-950 px-2 py-1">
            <span
              className={`h-2 w-2 rounded-full ${pipelineLength > 0 ? 'animate-pulse bg-emerald-500' : 'bg-amber-400'}`}
            />
            <span className="font-mono text-[10px] text-zinc-400">
              {pipelineLength > 0 ? 'HUB READY' : 'SETUP REQUIRED'}
            </span>
          </div>
        </div>
        <p className="max-w-lg text-sm leading-relaxed text-zinc-500">
          Multi-Provider Model Hub mit {providerCatalogLength} Providern. Verbinde Accounts per API
          Key oder OAuth, wähle Modelle und konfiguriere die Pipeline.
        </p>
      </div>
      <div className="relative z-10 flex flex-col items-center md:items-end">
        <div className="flex items-center gap-2">
          <button
            onClick={onRunConnectionProbe}
            disabled={isProbing}
            className="rounded-2xl bg-indigo-600 px-6 py-4 text-[10px] font-black tracking-widest text-white uppercase shadow-2xl shadow-indigo-600/30 transition-all hover:bg-indigo-500 active:scale-95 disabled:opacity-50"
          >
            {isProbing ? 'Prüfe...' : 'Connection Probe'}
          </button>
          <button
            onClick={onRunAllConnectionProbes}
            disabled={isTestingAll}
            className="rounded-2xl bg-zinc-800 px-4 py-4 text-[10px] font-black tracking-widest text-zinc-200 uppercase transition-all hover:bg-zinc-700 disabled:opacity-50"
          >
            {isTestingAll ? 'Teste...' : 'Probe All'}
          </button>
        </div>
        {probeResult && (
          <div
            className={`animate-in fade-in zoom-in-95 mt-4 max-w-sm rounded border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-mono text-[9px] break-words whitespace-pre-wrap ${
              lastProbeOk === false ? 'text-rose-400' : 'text-emerald-500'
            }`}
          >
            {probeResult}
          </div>
        )}
        {bulkProbeSummary && (
          <div className="animate-in fade-in zoom-in-95 mt-2 rounded border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-mono text-[9px] text-zinc-300">
            {bulkProbeSummary}
          </div>
        )}
      </div>
    </div>
  );
};

export default HeaderSection;
