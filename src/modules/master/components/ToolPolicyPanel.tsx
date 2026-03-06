import React, { useEffect, useState } from 'react';
import type { MasterToolPolicy } from '@/modules/master/types';

interface ToolPolicyPanelProps {
  policy: MasterToolPolicy | MasterSettingsToolPolicy;
  loading: boolean;
  onSave: (policy: MasterSettingsToolPolicy) => void;
}

type MasterSettingsToolPolicy = {
  security: 'deny' | 'allowlist' | 'full';
  ask: 'off' | 'on_miss' | 'always';
  allowlist: string[];
};

function parseAllowlist(value: string): string[] {
  return value
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function ToolPolicyPanel({
  policy,
  loading,
  onSave,
}: ToolPolicyPanelProps): React.ReactElement {
  const [security, setSecurity] = useState(policy.security);
  const [ask, setAsk] = useState(policy.ask);
  const [allowlist, setAllowlist] = useState(policy.allowlist.join('\n'));

  useEffect(() => {
    setSecurity(policy.security);
    setAsk(policy.ask);
    setAllowlist(policy.allowlist.join('\n'));
  }, [policy]);

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 shadow-xl">
      <div className="border-b border-zinc-800/80 bg-zinc-950/40 px-6 py-4">
        <h3 className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
          Tool Policy
        </h3>
        <p className="mt-1 text-sm text-zinc-500">
          Define the operator policy that sits below the persona safety ceiling.
        </p>
      </div>

      <div className="space-y-4 p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-xs font-semibold tracking-wide text-zinc-500 uppercase">
            Security mode
            <select
              value={security}
              onChange={(event) => setSecurity(event.target.value as typeof security)}
              className="mt-2 w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100"
            >
              <option value="deny">Deny</option>
              <option value="allowlist">Allowlist</option>
              <option value="full">Full</option>
            </select>
          </label>

          <label className="block text-xs font-semibold tracking-wide text-zinc-500 uppercase">
            Ask behavior
            <select
              value={ask}
              onChange={(event) => setAsk(event.target.value as typeof ask)}
              className="mt-2 w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100"
            >
              <option value="off">Off</option>
              <option value="on_miss">On Miss</option>
              <option value="always">Always</option>
            </select>
          </label>
        </div>

        <label className="block text-xs font-semibold tracking-wide text-zinc-500 uppercase">
          Persistent allowlist
          <textarea
            value={allowlist}
            onChange={(event) => setAllowlist(event.target.value)}
            rows={6}
            placeholder="shell.exec:D:/web/clawtest:*"
            className="mt-2 w-full resize-y rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100"
          />
        </label>

        <div className="flex justify-end">
          <button
            type="button"
            disabled={loading}
            onClick={() =>
              onSave({
                security,
                ask,
                allowlist: parseAllowlist(allowlist),
              })
            }
            className="rounded-2xl bg-indigo-600 px-5 py-2.5 text-xs font-black tracking-widest text-white uppercase shadow-lg shadow-indigo-600/25 transition-all hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Saving…' : 'Save Tool Policy'}
          </button>
        </div>
      </div>
    </section>
  );
}
