import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CommandPermission } from '@/shared/domain/types';
import { SECURITY_RULES } from '@/shared/domain/constants';
import { buildCommandSecurityChecks } from '@/modules/security/overview';
import type { SecurityCheck, SecurityCheckStatus } from '@/modules/security/overview';

interface SecurityStatusResponse {
  ok: boolean;
  checks?: SecurityCheck[];
  generatedAt?: string;
  error?: string;
}

interface PolicyExplainResponse {
  ok: boolean;
  generatedAt?: string;
  revision?: string;
  source?: string;
  channels?: {
    webchatEnabled?: boolean;
    telegramEnabled?: boolean;
    slackEnabled?: boolean;
  };
  error?: string;
}

const STATUS_META: Record<
  SecurityCheckStatus,
  { label: string; className: string; border: string }
> = {
  ok: {
    label: 'OK',
    className: 'text-emerald-500',
    border: 'border-emerald-500/20',
  },
  warning: {
    label: 'Warnung',
    className: 'text-amber-500',
    border: 'border-amber-500/20',
  },
  critical: {
    label: 'Kritisch',
    className: 'text-rose-500',
    border: 'border-rose-500/20',
  },
};

const CHECK_ORDER: Array<SecurityCheck['id']> = ['firewall', 'encryption', 'audit', 'isolation'];

const SecurityView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'overview' | 'commands'>('overview');
  const [commands, setCommands] = useState<CommandPermission[]>(SECURITY_RULES);
  const [remoteChecks, setRemoteChecks] = useState<SecurityCheck[]>([]);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [checkError, setCheckError] = useState<string | null>(null);

  const [showPolicyExplain, setShowPolicyExplain] = useState(false);
  const [policyExplainLoading, setPolicyExplainLoading] = useState(false);
  const [policyExplainError, setPolicyExplainError] = useState<string | null>(null);
  const [policyExplain, setPolicyExplain] = useState<PolicyExplainResponse | null>(null);

  const refreshStatus = useCallback(async () => {
    setIsChecking(true);
    setCheckError(null);
    try {
      const response = await fetch('/api/security/status', { cache: 'no-store' });
      const payload = (await response.json()) as SecurityStatusResponse;
      if (!response.ok || !payload.ok || !payload.checks) {
        throw new Error(payload.error || 'Security status check failed.');
      }
      setRemoteChecks(payload.checks);
      setLastCheckedAt(payload.generatedAt || new Date().toISOString());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Security status check failed.';
      setCheckError(message);
    } finally {
      setIsChecking(false);
    }
  }, []);

  const loadPolicyExplain = useCallback(async () => {
    setPolicyExplainLoading(true);
    setPolicyExplainError(null);
    try {
      const response = await fetch('/api/security/policy-explain', { cache: 'no-store' });
      const payload = (await response.json()) as PolicyExplainResponse;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Policy explain load failed.');
      }
      setPolicyExplain(payload);
    } catch (error) {
      setPolicyExplainError(error instanceof Error ? error.message : 'Policy explain load failed.');
      setPolicyExplain(null);
    } finally {
      setPolicyExplainLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const localChecks = useMemo(() => buildCommandSecurityChecks(commands), [commands]);

  const checks = useMemo(() => {
    const map = new Map<SecurityCheck['id'], SecurityCheck>();
    remoteChecks.forEach((check) => map.set(check.id, check));
    localChecks.forEach((check) => map.set(check.id, check));

    const fallbackCheck = (id: SecurityCheck['id']): SecurityCheck => ({
      id,
      label: id,
      status: 'warning',
      detail: 'Kein Sicherheitsstatus verfuegbar.',
    });

    return CHECK_ORDER.map((id) => map.get(id) || fallbackCheck(id));
  }, [localChecks, remoteChecks]);

  const summary = useMemo(
    () => ({
      ok: checks.filter((check) => check.status === 'ok').length,
      warning: checks.filter((check) => check.status === 'warning').length,
      critical: checks.filter((check) => check.status === 'critical').length,
    }),
    [checks],
  );

  const policyExplainText = useMemo(
    () => (policyExplain ? JSON.stringify(policyExplain, null, 2) : ''),
    [policyExplain],
  );

  return (
    <div className="animate-in fade-in space-y-8 duration-500">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-black tracking-tight text-white uppercase">
            Security Panel
          </h2>
          <div className="mt-1 text-[10px] tracking-widest text-zinc-500 uppercase">
            {lastCheckedAt
              ? `Last Check: ${new Date(lastCheckedAt).toLocaleString()}`
              : 'Last Check: Pending'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void refreshStatus()}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-[10px] font-black tracking-widest text-zinc-300 uppercase hover:text-white disabled:opacity-60"
            disabled={isChecking}
          >
            {isChecking ? 'Checking...' : 'Check Now'}
          </button>
          <div className="flex rounded-xl border border-zinc-800 bg-zinc-900/50 p-1">
            <button
              onClick={() => setActiveTab('overview')}
              className={`rounded-lg px-4 py-2 text-[10px] font-black tracking-widest uppercase ${
                activeTab === 'overview' ? 'bg-indigo-600 text-white' : 'text-zinc-500'
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setActiveTab('commands')}
              className={`rounded-lg px-4 py-2 text-[10px] font-black tracking-widest uppercase ${
                activeTab === 'commands' ? 'bg-indigo-600 text-white' : 'text-zinc-500'
              }`}
            >
              Whitelist
            </button>
          </div>
        </div>
      </header>

      {activeTab === 'overview' && (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="text-[10px] tracking-widest text-zinc-600 uppercase">OK</div>
              <div className="text-2xl font-black text-emerald-500">{summary.ok}</div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="text-[10px] tracking-widest text-zinc-600 uppercase">Warnings</div>
              <div className="text-2xl font-black text-amber-500">{summary.warning}</div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="text-[10px] tracking-widest text-zinc-600 uppercase">Critical</div>
              <div className="text-2xl font-black text-rose-500">{summary.critical}</div>
            </div>
          </div>

          {checkError && (
            <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-4 text-xs text-rose-400">
              Security-Check fehlgeschlagen: {checkError}
            </div>
          )}

          <div className="grid grid-cols-1 gap-6 md:grid-cols-4">
            {checks.map((check) => {
              const status = STATUS_META[check.status];
              return (
                <div
                  key={check.id}
                  className={`border bg-zinc-900/50 ${status.border} rounded-2xl p-6`}
                >
                  <h4 className="mb-2 text-xs font-black text-white uppercase">{check.label}</h4>
                  <div className={`font-mono text-[10px] uppercase ${status.className}`}>
                    Status: {status.label}
                  </div>
                  <div className="mt-2 text-[10px] leading-relaxed text-zinc-500">
                    {check.detail}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                  Effective Policy Explain
                </div>
                <div className="mt-1 text-[11px] text-zinc-500">
                  Zeigt die aktuell aktive Security- und Channel-Policy.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const next = !showPolicyExplain;
                    setShowPolicyExplain(next);
                    if (next && !policyExplain && !policyExplainLoading) {
                      void loadPolicyExplain();
                    }
                  }}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[10px] font-black tracking-widest text-zinc-300 uppercase hover:text-white disabled:opacity-60"
                  disabled={policyExplainLoading}
                >
                  {showPolicyExplain ? 'Hide' : 'Show'}
                </button>
                <button
                  onClick={() => void loadPolicyExplain()}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[10px] font-black tracking-widest text-zinc-300 uppercase hover:text-white disabled:opacity-60"
                  disabled={policyExplainLoading}
                >
                  {policyExplainLoading ? 'Loading...' : 'Refresh'}
                </button>
              </div>
            </div>

            {policyExplainError && (
              <div className="mb-3 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-400">
                Policy Explain Fehler: {policyExplainError}
              </div>
            )}

            {showPolicyExplain && policyExplain && (
              <div className="space-y-2">
                <div className="text-[11px] text-zinc-500">
                  Revision:{' '}
                  <span className="font-mono text-zinc-300">{policyExplain.revision || 'n/a'}</span>{' '}
                  | Source:{' '}
                  <span className="font-mono text-zinc-300">
                    {policyExplain.source || 'unknown'}
                  </span>
                </div>
                <pre className="max-h-80 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-[10px] leading-relaxed text-zinc-300">
                  {policyExplainText}
                </pre>
              </div>
            )}
          </div>
        </>
      )}

      {activeTab === 'commands' && (
        <div className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900">
          <table className="w-full text-left text-[11px]">
            <thead className="bg-zinc-950 font-black tracking-widest text-zinc-600 uppercase">
              <tr>
                <th className="px-8 py-4">Command</th>
                <th className="px-8 py-4">Risk</th>
                <th className="px-8 py-4 text-right">Access</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {commands.map((command) => (
                <tr key={command.id} className="hover:bg-zinc-800/20">
                  <td className="px-8 py-5 font-mono text-indigo-400">{command.command}</td>
                  <td className="px-8 py-5">
                    <span
                      className={`rounded px-2 py-0.5 text-[9px] font-black uppercase ${
                        command.risk === 'High'
                          ? 'text-rose-500'
                          : command.risk === 'Medium'
                            ? 'text-amber-500'
                            : 'text-emerald-500'
                      }`}
                    >
                      {command.risk}
                    </span>
                  </td>
                  <td className="px-8 py-5 text-right">
                    <button
                      onClick={() =>
                        setCommands((previous) =>
                          previous.map((rule) =>
                            rule.id === command.id ? { ...rule, enabled: !rule.enabled } : rule,
                          ),
                        )
                      }
                      className={`rounded px-3 py-1.5 text-[9px] font-black uppercase ${
                        command.enabled ? 'text-emerald-500' : 'text-zinc-600'
                      }`}
                    >
                      {command.enabled ? 'Allowed' : 'Blocked'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default SecurityView;
