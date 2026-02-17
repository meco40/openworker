import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CommandPermission } from '../types';
import { SECURITY_RULES } from '../constants';
import { buildCommandSecurityChecks } from '../src/modules/security/overview';
import type { SecurityCheck, SecurityCheckStatus } from '../src/modules/security/overview';

interface SecurityStatusResponse {
  ok: boolean;
  checks?: SecurityCheck[];
  generatedAt?: string;
  error?: string;
}

type ApprovalMode = 'deny' | 'ask_approve' | 'approve_always';

interface OpenAiWorkerToolPolicy {
  id: string;
  name: string;
  description: string;
  functionName: string;
  enabled: boolean;
  approvalMode: ApprovalMode;
}

interface OpenAiWorkerPolicyResponse {
  ok: boolean;
  tools?: OpenAiWorkerToolPolicy[];
  defaultApprovalMode?: ApprovalMode;
  error?: string;
}

const APPROVAL_MODE_OPTIONS: ApprovalMode[] = ['deny', 'ask_approve', 'approve_always'];

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
  const [activeTab, setActiveTab] = useState<'overview' | 'commands' | 'worker-policies'>(
    'overview',
  );
  const [commands, setCommands] = useState<CommandPermission[]>(SECURITY_RULES);
  const [remoteChecks, setRemoteChecks] = useState<SecurityCheck[]>([]);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [workerTools, setWorkerTools] = useState<OpenAiWorkerToolPolicy[]>([]);
  const [defaultApprovalMode, setDefaultApprovalMode] = useState<ApprovalMode>('ask_approve');
  const [isWorkerPolicyLoading, setIsWorkerPolicyLoading] = useState(true);
  const [workerPolicyError, setWorkerPolicyError] = useState<string | null>(null);
  const [workerPolicySavingId, setWorkerPolicySavingId] = useState<string | null>(null);
  const [isWorkerDefaultSaving, setIsWorkerDefaultSaving] = useState(false);

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

  const loadWorkerPolicies = useCallback(async () => {
    setIsWorkerPolicyLoading(true);
    setWorkerPolicyError(null);
    try {
      const response = await fetch('/api/worker/openai/tools', { cache: 'no-store' });
      const payload = (await response.json()) as OpenAiWorkerPolicyResponse;
      if (!response.ok || !payload.ok || !payload.tools) {
        throw new Error(payload.error || 'Worker policy load failed.');
      }
      setWorkerTools(payload.tools);
      setDefaultApprovalMode(payload.defaultApprovalMode || 'ask_approve');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Worker policy load failed.';
      setWorkerPolicyError(message);
      setWorkerTools([]);
    } finally {
      setIsWorkerPolicyLoading(false);
    }
  }, []);

  const patchWorkerPolicy = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch('/api/worker/openai/tools', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as OpenAiWorkerPolicyResponse;
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'Worker policy update failed.');
    }
    return payload;
  }, []);

  const handleWorkerToolToggle = useCallback(
    async (id: string, enabled: boolean) => {
      setWorkerPolicySavingId(id);
      setWorkerPolicyError(null);
      try {
        const payload = await patchWorkerPolicy({ id, enabled });
        if (!payload.tools && payload.defaultApprovalMode === undefined) {
          setWorkerTools((previous) =>
            previous.map((tool) => (tool.id === id ? { ...tool, enabled } : tool)),
          );
        }
        await loadWorkerPolicies();
      } catch (error) {
        setWorkerPolicyError(
          error instanceof Error ? error.message : 'Worker policy update failed.',
        );
      } finally {
        setWorkerPolicySavingId(null);
      }
    },
    [loadWorkerPolicies, patchWorkerPolicy],
  );

  const handleWorkerToolModeChange = useCallback(
    async (id: string, approvalMode: ApprovalMode) => {
      setWorkerPolicySavingId(id);
      setWorkerPolicyError(null);
      try {
        await patchWorkerPolicy({ id, approvalMode });
        setWorkerTools((previous) =>
          previous.map((tool) => (tool.id === id ? { ...tool, approvalMode } : tool)),
        );
      } catch (error) {
        setWorkerPolicyError(
          error instanceof Error ? error.message : 'Worker policy update failed.',
        );
      } finally {
        setWorkerPolicySavingId(null);
      }
    },
    [patchWorkerPolicy],
  );

  const handleDefaultModeChange = useCallback(
    async (mode: ApprovalMode) => {
      const previous = defaultApprovalMode;
      setDefaultApprovalMode(mode);
      setIsWorkerDefaultSaving(true);
      setWorkerPolicyError(null);
      try {
        await patchWorkerPolicy({ defaultApprovalMode: mode });
      } catch (error) {
        setDefaultApprovalMode(previous);
        setWorkerPolicyError(
          error instanceof Error ? error.message : 'Worker policy update failed.',
        );
      } finally {
        setIsWorkerDefaultSaving(false);
      }
    },
    [defaultApprovalMode, patchWorkerPolicy],
  );

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    void loadWorkerPolicies();
  }, [loadWorkerPolicies]);

  const localChecks = useMemo(() => buildCommandSecurityChecks(commands), [commands]);

  const checks = useMemo(() => {
    const map = new Map<SecurityCheck['id'], SecurityCheck>();
    remoteChecks.forEach((check) => map.set(check.id, check));
    localChecks.forEach((check) => map.set(check.id, check));

    const fallbackCheck = (id: SecurityCheck['id']): SecurityCheck => ({
      id,
      label: id,
      status: 'warning',
      detail: 'Kein Sicherheitsstatus verfügbar.',
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
            <button
              onClick={() => setActiveTab('worker-policies')}
              className={`rounded-lg px-4 py-2 text-[10px] font-black tracking-widest uppercase ${
                activeTab === 'worker-policies' ? 'bg-indigo-600 text-white' : 'text-zinc-500'
              }`}
            >
              Worker Policies
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

      {activeTab === 'worker-policies' && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="mb-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
              Global Default
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <select
                value={defaultApprovalMode}
                onChange={(event) =>
                  void handleDefaultModeChange(event.target.value as ApprovalMode)
                }
                disabled={isWorkerDefaultSaving}
                className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none disabled:opacity-60"
              >
                {APPROVAL_MODE_OPTIONS.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-zinc-500">
                Gilt für alle Tools ohne spezifisches Override.
              </span>
            </div>
          </div>

          {workerPolicyError && (
            <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-400">
              Worker-Policy Fehler: {workerPolicyError}
            </div>
          )}

          <div className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900">
            <table className="w-full text-left text-[11px]">
              <thead className="bg-zinc-950 font-black tracking-widest text-zinc-600 uppercase">
                <tr>
                  <th className="px-6 py-4">Tool</th>
                  <th className="px-6 py-4">Function</th>
                  <th className="px-6 py-4">Policy</th>
                  <th className="px-6 py-4 text-right">Access</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {workerTools.map((tool) => (
                  <tr key={tool.id} className="hover:bg-zinc-800/20">
                    <td className="px-6 py-4">
                      <div className="text-xs font-semibold text-white">{tool.name}</div>
                      <div className="mt-1 text-[10px] text-zinc-500">{tool.description}</div>
                    </td>
                    <td className="px-6 py-4 font-mono text-[10px] text-indigo-400">
                      {tool.functionName}
                    </td>
                    <td className="px-6 py-4">
                      <select
                        value={tool.approvalMode}
                        onChange={(event) =>
                          void handleWorkerToolModeChange(
                            tool.id,
                            event.target.value as ApprovalMode,
                          )
                        }
                        disabled={workerPolicySavingId === tool.id}
                        className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[10px] text-zinc-200 focus:border-indigo-500 focus:outline-none disabled:opacity-60"
                      >
                        {APPROVAL_MODE_OPTIONS.map((mode) => (
                          <option key={mode} value={mode}>
                            {mode}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button
                        onClick={() => void handleWorkerToolToggle(tool.id, !tool.enabled)}
                        disabled={workerPolicySavingId === tool.id}
                        className={`rounded px-3 py-1.5 text-[9px] font-black uppercase ${
                          tool.enabled ? 'text-emerald-500' : 'text-zinc-600'
                        } disabled:opacity-60`}
                      >
                        {tool.enabled ? 'Allowed' : 'Blocked'}
                      </button>
                    </td>
                  </tr>
                ))}
                {!isWorkerPolicyLoading && workerTools.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-6 py-6 text-center text-xs text-zinc-500">
                      Keine Worker-Tools gefunden.
                    </td>
                  </tr>
                )}
                {isWorkerPolicyLoading && (
                  <tr>
                    <td colSpan={4} className="px-6 py-6 text-center text-xs text-zinc-500">
                      Lade Worker-Policies ...
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default SecurityView;
