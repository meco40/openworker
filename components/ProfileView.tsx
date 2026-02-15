'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ControlPlaneMetricsState } from '../types';
import {
  applyOperatorProfileToConfig,
  computeOperatorUsageSnapshot,
  parseOperatorProfileFromConfig,
  type OperatorProfileState,
} from '../src/modules/profile/operatorProfileConfig';

type StatusTone = 'success' | 'error' | 'info';

interface StatusMessage {
  tone: StatusTone;
  text: string;
}

interface ConfigWarning {
  code: string;
  message: string;
}

interface ConfigResponse {
  ok: boolean;
  config?: Record<string, unknown>;
  revision?: string;
  warnings?: ConfigWarning[];
  error?: string;
  code?: string;
  currentRevision?: string;
}

interface ProfileViewProps {
  metricsState?: ControlPlaneMetricsState;
}

const STATUS_CLASS: Record<StatusTone, string> = {
  success: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
  error: 'text-rose-300 border-rose-500/30 bg-rose-500/10',
  info: 'text-zinc-200 border-zinc-700 bg-zinc-900/60',
};

function createLocalUuid(): string {
  const raw =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replaceAll('-', '').toUpperCase()
      : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.toUpperCase();

  const padded = `${raw}000000000000`;
  return `OC-${padded.slice(0, 4)}-${padded.slice(4, 8)}-${padded.slice(8, 13)}`;
}

function parsePositiveInt(rawValue: string, fallback: number): number {
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const ProfileView: React.FC<ProfileViewProps> = ({ metricsState }) => {
  const [profile, setProfile] = useState<OperatorProfileState>(() =>
    parseOperatorProfileFromConfig({}),
  );
  const [baselineConfig, setBaselineConfig] = useState<Record<string, unknown> | null>(null);
  const [baselineRevision, setBaselineRevision] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [showLimitEditor, setShowLimitEditor] = useState(false);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);

  const loadProfile = useCallback(async () => {
    setIsLoading(true);
    setStatusMessage(null);

    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      const payload = (await response.json()) as ConfigResponse;
      if (!response.ok || !payload.ok || !payload.config) {
        throw new Error(payload.error || 'Failed to load operator profile.');
      }

      const parsed = parseOperatorProfileFromConfig(payload.config);
      if (!parsed.localUuid) {
        parsed.localUuid = createLocalUuid();
      }

      setProfile(parsed);
      setBaselineConfig(payload.config);
      setBaselineRevision(String(payload.revision || ''));

      if ((payload.warnings || []).length > 0) {
        setStatusMessage({
          tone: 'info',
          text: `Profile loaded with ${(payload.warnings || []).length} compatibility warning(s).`,
        });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load operator profile.';
      setStatusMessage({ tone: 'error', text: message });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const usage = useMemo(
    () =>
      computeOperatorUsageSnapshot(
        {
          workspaceSlots: profile.workspaceSlots,
          dailyTokenBudget: profile.dailyTokenBudget,
        },
        metricsState?.metrics,
      ),
    [metricsState?.metrics, profile.dailyTokenBudget, profile.workspaceSlots],
  );

  const handleSave = useCallback(async () => {
    if (!baselineConfig || !baselineRevision) {
      setStatusMessage({
        tone: 'error',
        text: 'Missing config baseline. Reload profile before saving.',
      });
      return;
    }

    const displayName = profile.displayName.trim();
    if (!displayName) {
      setStatusMessage({ tone: 'error', text: 'Display Name is required.' });
      return;
    }

    const profileForSave = profile.localUuid.trim()
      ? profile
      : { ...profile, localUuid: createLocalUuid() };
    const nextConfig = applyOperatorProfileToConfig(baselineConfig, {
      ...profileForSave,
      displayName,
      primaryContact: profile.primaryContact.trim(),
    });

    setIsSaving(true);
    setStatusMessage(null);
    try {
      const response = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: nextConfig, revision: baselineRevision }),
      });
      const payload = (await response.json()) as ConfigResponse;

      if (!response.ok || !payload.ok || !payload.config) {
        if (payload.code === 'CONFIG_STALE_REVISION') {
          setStatusMessage({
            tone: 'error',
            text: 'Config changed in another session. Reload and retry save.',
          });
          if (typeof payload.currentRevision === 'string' && payload.currentRevision.length > 0) {
            setBaselineRevision(payload.currentRevision);
          }
          return;
        }
        throw new Error(payload.error || 'Failed to save operator profile.');
      }

      const savedProfile = parseOperatorProfileFromConfig(payload.config);
      setProfile(savedProfile);
      setBaselineConfig(payload.config);
      setBaselineRevision(String(payload.revision || ''));
      setStatusMessage({ tone: 'success', text: 'Operator profile saved.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save operator profile.';
      setStatusMessage({ tone: 'error', text: message });
    } finally {
      setIsSaving(false);
    }
  }, [baselineConfig, baselineRevision, profile]);

  return (
    <div className="animate-in fade-in mx-auto max-w-6xl space-y-10 pb-20 duration-500">
      <header>
        <h2 className="text-3xl font-black tracking-tight text-white uppercase">
          Operator Identity & Runtime
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          Manage your local operator profile and runtime settings.
        </p>
      </header>

      {statusMessage && (
        <div className={`rounded-2xl border px-4 py-3 text-xs ${STATUS_CLASS[statusMessage.tone]}`}>
          {statusMessage.text}
        </div>
      )}

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-3">
        {/* Profile Card */}
        <div className="space-y-8 lg:col-span-2">
          <div className="flex flex-col items-start gap-10 rounded-[2.5rem] border border-zinc-800 bg-zinc-900/40 p-10 shadow-2xl md:flex-row">
            <div className="flex shrink-0 flex-col items-center space-y-4">
              <div className="flex h-40 w-40 items-center justify-center rounded-[2rem] bg-gradient-to-br from-indigo-600 to-violet-700 text-6xl font-black text-white shadow-[0_0_50px_rgba(79,70,229,0.3)]">
                C
              </div>
              <button className="text-[10px] font-black tracking-widest text-indigo-400 uppercase transition-colors hover:text-indigo-300">
                Update Avatar
              </button>
            </div>

            <div className="w-full flex-1 space-y-6">
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="ml-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                    Display Name
                  </label>
                  <input
                    type="text"
                    value={profile.displayName}
                    onChange={(event) =>
                      setProfile((previous) => ({ ...previous, displayName: event.target.value }))
                    }
                    disabled={isLoading || isSaving}
                    className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-white transition-all focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <div className="space-y-2">
                  <label className="ml-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                    Local UUID
                  </label>
                  <input
                    type="text"
                    readOnly
                    value={profile.localUuid || 'Will be generated on save'}
                    className="w-full cursor-not-allowed rounded-2xl border border-zinc-800 bg-zinc-900 p-4 font-mono text-sm text-zinc-500"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="ml-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                  Primary Contact
                </label>
                <input
                  type="email"
                  value={profile.primaryContact}
                  onChange={(event) =>
                    setProfile((previous) => ({ ...previous, primaryContact: event.target.value }))
                  }
                  disabled={isLoading || isSaving}
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-white transition-all focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div className="flex space-x-4 border-t border-zinc-800 pt-6">
                <button
                  onClick={() => void handleSave()}
                  disabled={isLoading || isSaving}
                  className="flex-1 rounded-2xl bg-indigo-600 py-4 text-[10px] font-black tracking-widest text-white uppercase shadow-xl shadow-indigo-600/20 transition-all hover:bg-indigo-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSaving ? 'Saving...' : 'Save Changes'}
                </button>
                <button className="rounded-2xl border border-zinc-800 bg-zinc-900 px-8 py-4 text-[10px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:border-rose-500/30 hover:bg-rose-900/20 hover:text-rose-500">
                  Sign Out
                </button>
              </div>
            </div>
          </div>

          <div className="relative space-y-8 overflow-hidden rounded-[2.5rem] border border-zinc-800 bg-zinc-900/40 p-10 shadow-2xl">
            <div className="absolute top-0 right-0 -mt-32 -mr-32 h-64 w-64 rounded-full bg-emerald-500/5 blur-[80px]" />
            <h3 className="relative text-xl font-black tracking-tight text-white uppercase">
              Local Usage & Capacity
            </h3>

            <div className="relative grid grid-cols-1 gap-6 md:grid-cols-3">
              <div className="space-y-2 rounded-2xl border border-zinc-800 bg-zinc-950/50 p-6">
                <div className="text-[9px] font-black tracking-widest text-zinc-600 uppercase">
                  Workspace Slots
                </div>
                <div className="text-xl font-bold text-emerald-500">
                  {usage.workspaceUsed} / {usage.workspaceTotal}
                </div>
              </div>
              <div className="space-y-2 rounded-2xl border border-zinc-800 bg-zinc-950/50 p-6">
                <div className="text-[9px] font-black tracking-widest text-zinc-600 uppercase">
                  Active Agents
                </div>
                <div className="text-xl font-bold text-white">{usage.activeAgents} Running</div>
              </div>
              <div className="space-y-2 rounded-2xl border border-zinc-800 bg-zinc-950/50 p-6">
                <div className="text-[9px] font-black tracking-widest text-zinc-600 uppercase">
                  Compute Budget
                </div>
                <div className="text-xl font-bold text-indigo-400">{usage.remainingBudgetPercent}% REM</div>
                <div className="text-[10px] text-zinc-500">
                  {usage.tokensToday.toLocaleString()} used / {profile.dailyTokenBudget.toLocaleString()} daily
                </div>
              </div>
            </div>

            <button
              onClick={() => setShowLimitEditor((previous) => !previous)}
              className="w-full rounded-2xl border border-zinc-800 bg-zinc-900 py-5 text-[10px] font-black tracking-widest text-zinc-300 uppercase transition-all hover:bg-zinc-800"
            >
              Configure Local Limits
            </button>
            {showLimitEditor && (
              <div className="grid grid-cols-1 gap-4 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-6 md:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-[9px] font-black tracking-widest text-zinc-500 uppercase">
                    Workspace Slot Limit
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={profile.workspaceSlots}
                    onChange={(event) =>
                      setProfile((previous) => ({
                        ...previous,
                        workspaceSlots: parsePositiveInt(event.target.value, previous.workspaceSlots),
                      }))
                    }
                    disabled={isSaving}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-sm text-white focus:border-indigo-500 focus:outline-none disabled:opacity-60"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-[9px] font-black tracking-widest text-zinc-500 uppercase">
                    Daily Token Budget
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={profile.dailyTokenBudget}
                    onChange={(event) =>
                      setProfile((previous) => ({
                        ...previous,
                        dailyTokenBudget: parsePositiveInt(
                          event.target.value,
                          previous.dailyTokenBudget,
                        ),
                      }))
                    }
                    disabled={isSaving}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-sm text-white focus:border-indigo-500 focus:outline-none disabled:opacity-60"
                  />
                </label>
              </div>
            )}
          </div>
        </div>

        {/* Sidebar Info */}
        <div className="space-y-6">
          <div className="rounded-[2.5rem] border border-zinc-800 bg-zinc-900/60 p-8 shadow-xl">
            <h4 className="mb-6 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
              Data Scope
            </h4>
            <div className="space-y-4">
              <div className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
                <span className="text-xs text-zinc-400">Personal Data</span>
                <span className="text-[9px] font-black text-emerald-500 uppercase">Local</span>
              </div>
              <div className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
                <span className="text-xs text-zinc-400">Workspace History</span>
                <span className="text-[9px] font-black text-indigo-400 uppercase">Local</span>
              </div>
              <div className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
                <span className="text-xs text-zinc-400">Prompt Library</span>
                <span className="text-[9px] font-black text-zinc-600 uppercase">Local Only</span>
              </div>
            </div>
          </div>

          <div className="rounded-[2.5rem] border border-zinc-800 bg-zinc-900/60 p-8 shadow-xl">
            <h4 className="mb-6 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
              Security Tokens
            </h4>
            <div className="space-y-4">
              <button className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 py-4 text-[10px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:bg-zinc-900 hover:text-white">
                Manage API Keys
              </button>
              <button className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 py-4 text-[10px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:bg-zinc-900 hover:text-white">
                Audit Logs
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProfileView;
