type ActivityLogPanelProps = {
  pairingLogs: string[];
};

export function ActivityLogPanel({ pairingLogs }: ActivityLogPanelProps) {
  return (
    <div className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h4 className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">Activity Log</h4>
        {pairingLogs.length > 0 && (
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
            {pairingLogs.length}
          </span>
        )}
      </div>
      <div className="flex-1 space-y-1.5 overflow-y-auto">
        {pairingLogs.length === 0 ? (
          <p className="pt-8 text-center text-xs text-zinc-600">No activity yet</p>
        ) : (
          pairingLogs.map((log, index) => {
            const isError = /fail|error|warn|reject/i.test(log);
            const isSuccess = /success|confirmed|live|established|connected/i.test(log);
            return (
              <div
                key={index}
                className={`rounded-lg border px-3 py-2 font-mono text-[11px] leading-relaxed ${
                  isError
                    ? 'border-rose-900/30 bg-rose-950/20 text-rose-400'
                    : isSuccess
                      ? 'border-emerald-900/30 bg-emerald-950/20 text-emerald-400'
                      : 'border-zinc-800/60 bg-zinc-950/50 text-zinc-500'
                }`}
              >
                {log}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
