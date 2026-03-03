'use client';

import React, { useState } from 'react';
import { useOpsNodes } from '@/modules/ops/hooks/useOpsNodes';
import { formatDateTime } from '@/shared/lib/dateFormat';
import { useConfirmDialog } from '@/components/shared/ConfirmDialogProvider';

const BRIDGE_CHANNELS = new Set(['whatsapp', 'imessage']);

function formatLeaseAge(value: number | null): string {
  if (value === null) return 'n/a';
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m`;
  return `${Math.floor(value / 3600)}h`;
}

function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold text-white">{value}</div>
    </div>
  );
}

const NodesView: React.FC = () => {
  const confirm = useConfirmDialog();
  const state = useOpsNodes();
  const data = state.data?.nodes;
  const [execCommandDraft, setExecCommandDraft] = useState('');
  const [connectTokenDraft, setConnectTokenDraft] = useState('');
  const [accountDraft, setAccountDraft] = useState('');

  const hasPendingAction = Boolean(state.pendingAction);
  const personas = data?.personas || [];
  const approvals = data?.execApprovals.items || [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-white">Nodes</h2>
          <p className="text-sm text-zinc-400">
            Runtime diagnostics plus direct operability controls for channels and exec policy.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void state.refresh();
          }}
          disabled={state.loading || state.refreshing || hasPendingAction}
          className="rounded-md border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-100 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {state.refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </header>

      {state.error && (
        <div className="rounded-md border border-rose-800 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
          {state.error}
        </div>
      )}
      {state.mutationError && (
        <div className="rounded-md border border-rose-800 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
          {state.mutationError}
        </div>
      )}
      {state.mutationNotice && (
        <button
          type="button"
          onClick={() => state.actions.clearMutationNotice()}
          className="w-full rounded-md border border-emerald-800 bg-emerald-950/30 px-4 py-3 text-left text-sm text-emerald-200"
        >
          {state.mutationNotice}
        </button>
      )}

      <section className="grid gap-3 md:grid-cols-4">
        <MetricCard label="Health Status" value={data?.health.status ?? 'unknown'} />
        <MetricCard label="Doctor Findings" value={data?.doctor.findings ?? 0} />
        <MetricCard label="Active Rules" value={data?.automation.activeRules ?? 0} />
        <MetricCard
          label="Lease Age"
          value={formatLeaseAge(data?.automation.leaseAgeSeconds ?? null)}
        />
      </section>

      {state.loading ? (
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-sm text-zinc-300">
          Loading node diagnostics...
        </section>
      ) : (
        <>
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <h3 className="mb-2 text-sm font-semibold text-zinc-100">Diagnostics</h3>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-300">
                <div className="font-semibold text-zinc-200">Health</div>
                <div className="mt-1">Status: {data?.health.status ?? 'unknown'}</div>
                <div>
                  Summary: ok {data?.health.summary.ok ?? 0}, warning{' '}
                  {data?.health.summary.warning ?? 0}, critical {data?.health.summary.critical ?? 0}
                </div>
              </div>
              <div className="rounded border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-300">
                <div className="font-semibold text-zinc-200">Doctor</div>
                <div className="mt-1">Status: {data?.doctor.status ?? 'unknown'}</div>
                <div>Recommendations: {data?.doctor.recommendations ?? 0}</div>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <h3 className="mb-3 text-sm font-semibold text-zinc-100">Exec Approvals</h3>
            <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
              <input
                value={execCommandDraft}
                onChange={(event) => setExecCommandDraft(event.target.value)}
                placeholder="echo hello"
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
              />
              <button
                type="button"
                disabled={hasPendingAction}
                onClick={() => {
                  void state.actions.approveExecCommand(execCommandDraft);
                  setExecCommandDraft('');
                }}
                className="rounded border border-emerald-700 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-900/30 disabled:opacity-60"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={hasPendingAction}
                onClick={async () => {
                  const confirmed = await confirm({
                    title: 'Approvals leeren?',
                    description: 'Clear all exec approvals?',
                    confirmLabel: 'Clear',
                    tone: 'danger',
                  });
                  if (!confirmed) {
                    return;
                  }
                  void state.actions.clearExecApprovals();
                }}
                className="rounded border border-rose-700 px-3 py-1.5 text-xs font-semibold text-rose-200 transition hover:bg-rose-900/30 disabled:opacity-60"
              >
                Clear
              </button>
            </div>
            <div className="mt-3 text-xs text-zinc-400">
              Total approvals: {data?.execApprovals.total ?? 0}
            </div>
            {!approvals.length ? (
              <div className="mt-3 text-sm text-zinc-400">No approved commands.</div>
            ) : (
              <div className="mt-3 space-y-2">
                {approvals.map((entry) => (
                  <div
                    key={entry.fingerprint}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-950/70 px-3 py-2"
                  >
                    <div>
                      <div className="font-mono text-xs text-zinc-100">{entry.command}</div>
                      <div className="text-[11px] text-zinc-500">
                        updated {formatDateTime(entry.updatedAt)}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={hasPendingAction}
                      onClick={() => {
                        void state.actions.revokeExecCommand(entry.command);
                      }}
                      className="rounded border border-rose-700 px-2 py-1 text-[11px] text-rose-200 transition hover:bg-rose-900/30 disabled:opacity-60"
                    >
                      Revoke
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <h3 className="mb-3 text-sm font-semibold text-zinc-100">Channel Controls</h3>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-xs text-zinc-400">
                <span>Connect token (optional)</span>
                <input
                  value={connectTokenDraft}
                  onChange={(event) => setConnectTokenDraft(event.target.value)}
                  placeholder="token for telegram/discord/slack"
                  className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
                />
              </label>
              <label className="space-y-1 text-xs text-zinc-400">
                <span>Account ID (optional)</span>
                <input
                  value={accountDraft}
                  onChange={(event) => setAccountDraft(event.target.value)}
                  placeholder="default"
                  className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
                />
              </label>
            </div>

            <div className="mt-3 overflow-x-auto rounded border border-zinc-800">
              <table className="w-full min-w-[1100px] text-left text-xs">
                <thead className="border-b border-zinc-800 text-zinc-500 uppercase">
                  <tr>
                    <th className="px-3 py-2">Channel</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Persona</th>
                    <th className="px-3 py-2">Capabilities</th>
                    <th className="px-3 py-2">Accounts</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.channels || []).map((channel) => (
                    <tr
                      key={channel.channel}
                      className="border-b border-zinc-800/80 align-top text-zinc-200"
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium">{channel.channel}</div>
                        <div className="text-[11px] text-zinc-500">
                          {channel.peerName || channel.externalPeerId || 'n/a'}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div>{channel.status}</div>
                        <div className="text-[11px] text-zinc-500">
                          {channel.transport || 'n/a'} · {formatDateTime(channel.lastSeenAt)}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={channel.personaId || ''}
                          disabled={hasPendingAction}
                          onChange={(event) => {
                            const nextPersonaId = event.target.value.trim() || null;
                            void state.actions.setChannelPersona(channel.channel, nextPersonaId);
                          }}
                          className="w-44 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
                        >
                          <option value="">No persona</option>
                          {personas.map((persona) => (
                            <option key={persona.id} value={persona.id}>
                              {persona.emoji} {persona.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-zinc-300">
                        <div>
                          in:{channel.supportsInbound ? 'yes' : 'no'} / out:
                          {channel.supportsOutbound ? 'yes' : 'no'}
                        </div>
                        <div>
                          pair:{channel.supportsPairing ? 'yes' : 'no'} / stream:
                          {channel.supportsStreaming ? 'yes' : 'no'}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-zinc-300">
                        {!channel.accounts?.length ? (
                          <span className="text-zinc-500">n/a</span>
                        ) : (
                          <div className="space-y-1">
                            {channel.accounts.map((account) => (
                              <div key={account.accountId} className="text-[11px]">
                                {account.accountId} ({account.pairingStatus || 'unknown'})
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={hasPendingAction || !channel.supportsPairing}
                            onClick={() => {
                              void state.actions.connectChannel(
                                channel.channel,
                                connectTokenDraft || undefined,
                                accountDraft || undefined,
                              );
                            }}
                            className="rounded border border-emerald-700 px-2 py-1 text-[11px] text-emerald-200 transition hover:bg-emerald-900/30 disabled:opacity-60"
                          >
                            Connect
                          </button>
                          <button
                            type="button"
                            disabled={hasPendingAction || !channel.supportsPairing}
                            onClick={async () => {
                              const confirmed = await confirm({
                                title: 'Channel trennen?',
                                description: `Disconnect channel "${channel.channel}"?`,
                                confirmLabel: 'Disconnect',
                                tone: 'danger',
                              });
                              if (!confirmed) {
                                return;
                              }
                              void state.actions.disconnectChannel(
                                channel.channel,
                                accountDraft || undefined,
                              );
                            }}
                            className="rounded border border-rose-700 px-2 py-1 text-[11px] text-rose-200 transition hover:bg-rose-900/30 disabled:opacity-60"
                          >
                            Disconnect
                          </button>
                          {BRIDGE_CHANNELS.has(channel.channel) && (
                            <button
                              type="button"
                              disabled={hasPendingAction}
                              onClick={() => {
                                void state.actions.rotateChannelSecret(
                                  channel.channel,
                                  accountDraft || undefined,
                                );
                              }}
                              className="rounded border border-amber-700 px-2 py-1 text-[11px] text-amber-200 transition hover:bg-amber-900/30 disabled:opacity-60"
                            >
                              Rotate Secret
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <h3 className="mb-2 text-sm font-semibold text-zinc-100">Telegram Pending Pairing</h3>
            {!data?.telegramPairing.hasPending ? (
              <div className="text-sm text-zinc-400">No pending Telegram pairing request.</div>
            ) : (
              <div className="space-y-2 text-sm text-zinc-300">
                <div>Status: {data.telegramPairing.status}</div>
                <div>Chat: {data.telegramPairing.pendingChatId || 'n/a'}</div>
                <div>Expires: {formatDateTime(data.telegramPairing.pendingExpiresAt)}</div>
                <button
                  type="button"
                  disabled={hasPendingAction}
                  onClick={async () => {
                    const confirmed = await confirm({
                      title: 'Pairing ablehnen?',
                      description: 'Reject pending Telegram pairing request?',
                      confirmLabel: 'Reject',
                      tone: 'danger',
                    });
                    if (!confirmed) {
                      return;
                    }
                    void state.actions.rejectTelegramPending();
                  }}
                  className="rounded border border-rose-700 px-3 py-1.5 text-xs font-semibold text-rose-200 transition hover:bg-rose-900/30 disabled:opacity-60"
                >
                  Reject Pending
                </button>
              </div>
            )}
          </section>

          <section className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/50">
            <div className="border-b border-zinc-800 px-4 py-3 text-sm font-semibold text-zinc-200">
              Channel Bindings
            </div>
            {!data?.channels.length ? (
              <div className="px-4 py-6 text-sm text-zinc-400">No channel bindings found.</div>
            ) : (
              <table className="w-full min-w-[780px] text-left text-xs">
                <thead className="border-b border-zinc-800 text-zinc-500 uppercase">
                  <tr>
                    <th className="px-4 py-3">Channel</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Peer</th>
                    <th className="px-4 py-3">Transport</th>
                    <th className="px-4 py-3">Last Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {data.channels.map((channel) => (
                    <tr key={channel.channel} className="border-b border-zinc-800/80 text-zinc-200">
                      <td className="px-4 py-3">{channel.channel}</td>
                      <td className="px-4 py-3">{channel.status}</td>
                      <td className="px-4 py-3">
                        {channel.peerName || channel.externalPeerId || 'n/a'}
                      </td>
                      <td className="px-4 py-3">{channel.transport || 'n/a'}</td>
                      <td className="px-4 py-3">{channel.lastSeenAt || 'n/a'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
};

export default NodesView;
