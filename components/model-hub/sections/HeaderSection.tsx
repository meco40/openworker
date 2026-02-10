import React from 'react';

interface HeaderSectionProps {
  pipelineLength: number;
  providerCatalogLength: number;
  isProbing: boolean;
  isTestingAll: boolean;
  probeResult: string | null;
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
  bulkProbeSummary,
  onRunConnectionProbe,
  onRunAllConnectionProbes,
}) => {
  return (
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 bg-zinc-900/40 p-8 rounded-3xl border border-zinc-800 shadow-2xl relative overflow-hidden group">
      <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-600/10 rounded-full blur-3xl -mr-32 -mt-32" />
      <div className="relative z-10">
        <div className="flex items-center space-x-3 mb-2">
          <h2 className="text-3xl font-black text-white tracking-tight uppercase">Gateway Control</h2>
          <div className="flex items-center space-x-2 bg-zinc-950 px-2 py-1 rounded border border-zinc-800">
            <span className={`w-2 h-2 rounded-full ${pipelineLength > 0 ? 'bg-emerald-500 animate-pulse' : 'bg-amber-400'}`} />
            <span className="text-[10px] font-mono text-zinc-400">
              {pipelineLength > 0 ? 'HUB READY' : 'SETUP REQUIRED'}
            </span>
          </div>
        </div>
        <p className="text-sm text-zinc-500 max-w-lg leading-relaxed">
          Multi-Provider Model Hub mit {providerCatalogLength} Providern. Verbinde Accounts per API Key oder OAuth, wähle Modelle und konfiguriere die Pipeline.
        </p>
      </div>
      <div className="relative z-10 flex flex-col items-center md:items-end">
        <div className="flex items-center gap-2">
          <button onClick={onRunConnectionProbe} disabled={isProbing} className="px-6 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all shadow-2xl shadow-indigo-600/30 active:scale-95 disabled:opacity-50">
            {isProbing ? 'Prüfe...' : 'Connection Probe'}
          </button>
          <button onClick={onRunAllConnectionProbes} disabled={isTestingAll} className="px-4 py-4 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all disabled:opacity-50">
            {isTestingAll ? 'Teste...' : 'Probe All'}
          </button>
        </div>
        {probeResult && (
          <div className="mt-4 text-[9px] font-mono text-emerald-500 bg-zinc-950 px-3 py-1.5 rounded border border-zinc-800 animate-in fade-in zoom-in-95 max-w-sm truncate">
            {probeResult}
          </div>
        )}
        {bulkProbeSummary && (
          <div className="mt-2 text-[9px] font-mono text-zinc-300 bg-zinc-950 px-3 py-1.5 rounded border border-zinc-800 animate-in fade-in zoom-in-95">
            {bulkProbeSummary}
          </div>
        )}
      </div>
    </div>
  );
};

export default HeaderSection;
