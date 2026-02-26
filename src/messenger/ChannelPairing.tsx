import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChannelType, CoupledChannel } from '@/shared/domain/types';
import { WhatsAppHandler } from '@/messenger/whatsapp/WhatsAppHandler';
import { TelegramHandler } from '@/messenger/telegram/TelegramHandler';
import { GenericChannelHandler } from '@/messenger/shared/GenericChannelHandler';

interface ChannelPairingProps {
  coupledChannels: Record<string, CoupledChannel>;
  onUpdateCoupling: (id: string, update: Partial<CoupledChannel>) => void;
  onSimulateIncoming?: (content: string, platform: ChannelType) => void;
}

type ActiveTab = 'whatsapp' | 'telegram' | 'discord' | 'imessage' | 'slack';
type BridgeTab = 'whatsapp' | 'imessage';

type BridgeAccount = {
  accountId: string;
  pairingStatus?: string | null;
  peerName?: string | null;
  lastSeenAt?: string | null;
  allowFrom?: string[];
};

type ChannelStateResponse = {
  ok?: boolean;
  channels?: Array<{
    channel?: string;
    accounts?: BridgeAccount[];
  }>;
};

type WhatsAppAccountsResponse = {
  ok?: boolean;
  accounts?: BridgeAccount[];
};

const BRIDGE_TABS: BridgeTab[] = ['whatsapp', 'imessage'];
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function mapBridgeStatusToUiStatus(status: string | null | undefined): CoupledChannel['status'] {
  if (status === 'connected') return 'connected';
  if (status === 'awaiting_code') return 'awaiting_code';
  if (status === 'pairing') return 'pairing';
  return 'idle';
}

function normalizeAccountId(input: string): string {
  return input.trim().toLowerCase();
}

const ChannelPairing: React.FC<ChannelPairingProps> = ({
  coupledChannels,
  onUpdateCoupling,
  onSimulateIncoming,
}) => {
  const [activeTab, setActiveTab] = useState<ActiveTab>('whatsapp');
  const [pairingLogs, setPairingLogs] = useState<string[]>([]);
  const [inputToken, setInputToken] = useState('');
  const [simMessage, setSimMessage] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [isConfirmingCode, setIsConfirmingCode] = useState(false);
  const [telegramTransport, setTelegramTransport] = useState<'webhook' | 'polling' | null>(null);
  const [bridgeAccounts, setBridgeAccounts] = useState<Record<BridgeTab, BridgeAccount[]>>({
    whatsapp: [],
    imessage: [],
  });
  const [selectedBridgeAccount, setSelectedBridgeAccount] = useState<Record<BridgeTab, string>>({
    whatsapp: 'default',
    imessage: 'default',
  });
  const [newBridgeAccountDraft, setNewBridgeAccountDraft] = useState<Record<BridgeTab, string>>({
    whatsapp: '',
    imessage: '',
  });
  const [allowFromInput, setAllowFromInput] = useState('');
  const [isSavingAllowFrom, setIsSavingAllowFrom] = useState(false);
  const telegramPollingErrorLogged = useRef(false);

  const addLog = useCallback((msg: string) => {
    setPairingLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev.slice(0, 9)]);
  }, []);

  const isBridgeTab = activeTab === 'whatsapp' || activeTab === 'imessage';
  const activeBridgeTab = isBridgeTab ? (activeTab as BridgeTab) : null;
  const activeAccountSelectId = activeBridgeTab ? `${activeBridgeTab}-active-account` : '';
  const newAccountInputId = activeBridgeTab ? `${activeBridgeTab}-new-account` : '';
  const allowFromInputId = activeBridgeTab ? `${activeBridgeTab}-allow-from` : '';

  const selectedBridgeAccountMeta = useMemo(() => {
    if (!activeBridgeTab) return null;
    const selectedId = selectedBridgeAccount[activeBridgeTab] || 'default';
    return (
      bridgeAccounts[activeBridgeTab].find((entry) => entry.accountId === selectedId) || {
        accountId: selectedId,
      }
    );
  }, [activeBridgeTab, bridgeAccounts, selectedBridgeAccount]);

  const accountOptions = useMemo(() => {
    if (!activeBridgeTab) return ['default'];
    const ids = bridgeAccounts[activeBridgeTab].map((entry) => entry.accountId);
    const selected = selectedBridgeAccount[activeBridgeTab];
    return Array.from(new Set(['default', selected, ...ids].filter(Boolean)));
  }, [activeBridgeTab, bridgeAccounts, selectedBridgeAccount]);

  const currentChannelBase = coupledChannels[activeTab];
  const currentChannel =
    activeBridgeTab && selectedBridgeAccountMeta
      ? {
          ...currentChannelBase,
          status: mapBridgeStatusToUiStatus(selectedBridgeAccountMeta.pairingStatus),
          peerName: selectedBridgeAccountMeta.peerName || currentChannelBase.peerName,
        }
      : currentChannelBase;

  const refreshBridgeAccounts = useCallback(async () => {
    try {
      const response = await fetch('/api/channels/state', { cache: 'no-store' });
      const payload = (await response.json()) as ChannelStateResponse;
      if (!response.ok || !payload.ok || !Array.isArray(payload.channels)) {
        return;
      }

      const nextAccounts: Record<BridgeTab, BridgeAccount[]> = {
        whatsapp: [],
        imessage: [],
      };
      for (const channel of payload.channels) {
        const id = String(channel.channel || '');
        if ((id === 'whatsapp' || id === 'imessage') && Array.isArray(channel.accounts)) {
          nextAccounts[id] = channel.accounts.filter(
            (entry) => typeof entry.accountId === 'string' && entry.accountId.trim().length > 0,
          );
        }
      }
      setBridgeAccounts(nextAccounts);

      setSelectedBridgeAccount((previous) => {
        const next = { ...previous };
        for (const tab of BRIDGE_TABS) {
          const selected = previous[tab];
          const options = Array.from(
            new Set(['default', ...nextAccounts[tab].map((entry) => entry.accountId)]),
          );
          if (!options.includes(selected)) {
            next[tab] = options[0] || 'default';
          }
        }
        return next;
      });
    } catch {
      // keep local UI state when endpoint is temporarily unavailable
    }
  }, []);

  const refreshWhatsAppAllowFrom = useCallback(async (accountId: string) => {
    try {
      const response = await fetch('/api/channels/whatsapp/accounts', { cache: 'no-store' });
      const payload = (await response.json()) as WhatsAppAccountsResponse;
      if (!response.ok || !payload.ok || !Array.isArray(payload.accounts)) {
        return;
      }
      const entry = payload.accounts.find((account) => account.accountId === accountId);
      setAllowFromInput(Array.isArray(entry?.allowFrom) ? entry!.allowFrom!.join(', ') : '');
    } catch {
      // ignore read errors and keep existing input draft
    }
  }, []);

  useEffect(() => {
    void refreshBridgeAccounts();
  }, [refreshBridgeAccounts]);

  useEffect(() => {
    if (activeTab !== 'whatsapp') {
      return;
    }
    const selectedAccount = selectedBridgeAccount.whatsapp || 'default';
    void refreshWhatsAppAllowFrom(selectedAccount);
  }, [activeTab, refreshWhatsAppAllowFrom, selectedBridgeAccount.whatsapp]);

  const startPairing = async () => {
    setPairingCode('');
    setIsConfirmingCode(false);
    onUpdateCoupling(activeTab, { status: 'pairing' });

    const accountId = activeBridgeTab ? selectedBridgeAccount[activeBridgeTab] || 'default' : null;
    addLog(
      accountId
        ? `Initiating pairing sequence for ${activeTab.toUpperCase()} [${accountId}]...`
        : `Initiating pairing sequence for ${activeTab.toUpperCase()}...`,
    );

    try {
      const response = await fetch('/api/channels/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: activeTab,
          accountId: accountId || undefined,
          token:
            activeTab === 'telegram' || activeTab === 'discord' || activeTab === 'slack'
              ? inputToken
              : undefined,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || 'Pairing failed.');
      }

      const nextStatus = payload.status === 'awaiting_code' ? 'awaiting_code' : 'connected';
      if (activeTab === 'telegram') {
        const transport = payload.transport === 'polling' ? 'polling' : 'webhook';
        setTelegramTransport(nextStatus === 'awaiting_code' ? transport : null);
      }
      onUpdateCoupling(activeTab, {
        status: nextStatus,
        peerName: payload.peerName,
        connectedAt: nextStatus === 'connected' ? payload.connectedAt : undefined,
      });
      await refreshBridgeAccounts();

      if (nextStatus === 'awaiting_code') {
        addLog('Token valid. Send a Telegram message to the bot to receive the pairing code.');
        if (activeTab === 'telegram' && payload.transport === 'polling') {
          addLog('Webhook URL unavailable. Using Telegram polling fallback.');
        }
      } else {
        const suffix = payload.accountId ? ` [${payload.accountId}]` : '';
        addLog(
          `Success! ${activeTab.toUpperCase()} bridge established${suffix} (${payload.peerName}).`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      onUpdateCoupling(activeTab, { status: 'idle', peerName: undefined, connectedAt: undefined });
      addLog(`Pairing failed: ${message}`);
    }
  };

  const confirmTelegramPairingCode = async () => {
    const code = pairingCode.trim();
    if (!code) {
      addLog('Pairing code is required.');
      return;
    }

    setIsConfirmingCode(true);
    addLog('Verifying Telegram pairing code...');
    try {
      const response = await fetch('/api/channels/telegram/pairing/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || 'Pairing code verification failed.');
      }

      onUpdateCoupling('telegram', {
        status: 'connected',
        peerName: payload.chatId ? `telegram:${payload.chatId}` : currentChannel.peerName,
        connectedAt: payload.connectedAt,
      });
      setTelegramTransport(null);
      setPairingCode('');
      addLog(`Telegram pairing confirmed (${payload.chatId}).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      addLog(`Pairing code rejected: ${message}`);
    } finally {
      setIsConfirmingCode(false);
    }
  };

  const disconnect = async () => {
    const accountId = activeBridgeTab ? selectedBridgeAccount[activeBridgeTab] || 'default' : null;
    addLog(
      accountId
        ? `Disconnecting ${activeTab.toUpperCase()} bridge [${accountId}]...`
        : `Disconnecting ${activeTab.toUpperCase()} bridge...`,
    );
    try {
      const response = await fetch('/api/channels/pair', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: activeTab, accountId: accountId || undefined }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || 'Disconnect failed.');
      }
      addLog(
        accountId
          ? `${activeTab.toUpperCase()} bridge dismantled for account [${accountId}].`
          : `${activeTab.toUpperCase()} bridge dismantled successfully.`,
      );
      onUpdateCoupling(activeTab, { status: 'idle', peerName: undefined, connectedAt: undefined });
      setInputToken('');
      setPairingCode('');
      setIsConfirmingCode(false);
      if (activeTab === 'telegram') {
        setTelegramTransport(null);
      }
      await refreshBridgeAccounts();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      addLog(`Disconnect failed: ${message}`);
    }
  };

  const saveAllowFrom = async () => {
    const accountId = selectedBridgeAccount.whatsapp || 'default';
    setIsSavingAllowFrom(true);
    try {
      const response = await fetch('/api/channels/whatsapp/accounts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId,
          allowFrom: allowFromInput,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || 'Saving allowlist failed.');
      }
      addLog(`Saved allowlist for WhatsApp account [${accountId}].`);
      await refreshBridgeAccounts();
      await refreshWhatsAppAllowFrom(accountId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      addLog(`Allowlist update failed: ${message}`);
    } finally {
      setIsSavingAllowFrom(false);
    }
  };

  const applyNewAccountId = () => {
    if (!activeBridgeTab) return;
    const candidate = normalizeAccountId(newBridgeAccountDraft[activeBridgeTab] || '');
    if (!candidate) {
      return;
    }
    if (!ACCOUNT_ID_PATTERN.test(candidate)) {
      addLog('Invalid account id. Use lowercase letters, digits, "_" or "-".');
      return;
    }
    setSelectedBridgeAccount((previous) => ({ ...previous, [activeBridgeTab]: candidate }));
    setNewBridgeAccountDraft((previous) => ({ ...previous, [activeBridgeTab]: '' }));
    addLog(`Selected account [${candidate}] for ${activeBridgeTab.toUpperCase()}.`);
  };

  useEffect(() => {
    const telegramChannel = coupledChannels.telegram;
    if (
      !telegramChannel ||
      telegramChannel.status !== 'awaiting_code' ||
      telegramTransport !== 'polling'
    ) {
      return;
    }

    let stopped = false;
    let inFlight = false;

    const pollUpdates = async () => {
      if (stopped || inFlight) {
        return;
      }
      inFlight = true;
      try {
        const response = await fetch('/api/channels/telegram/pairing/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const payload = await response.json();
        if (!response.ok || !payload?.ok) {
          if (!telegramPollingErrorLogged.current) {
            addLog(`Telegram polling warning: ${payload?.error || 'Polling request failed.'}`);
            telegramPollingErrorLogged.current = true;
          }
          return;
        }
        telegramPollingErrorLogged.current = false;
        if (payload.codeIssued) {
          addLog('Pairing code sent to Telegram via polling fallback.');
        }
      } catch (error) {
        if (!telegramPollingErrorLogged.current) {
          const message = error instanceof Error ? error.message : 'Polling request failed.';
          addLog(`Telegram polling warning: ${message}`);
          telegramPollingErrorLogged.current = true;
        }
      } finally {
        inFlight = false;
      }
    };

    pollUpdates();
    const timer = setInterval(pollUpdates, 3000);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [addLog, coupledChannels.telegram, telegramTransport]);

  const handleSimulate = () => {
    if (!simMessage.trim() || !onSimulateIncoming) return;
    onSimulateIncoming(simMessage, coupledChannels[activeTab].type);
    addLog(`Ingress test message routed from ${activeTab.toUpperCase()}`);
    setSimMessage('');
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-12">
      {/* Page Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white">Messenger Coupling</h2>
          <p className="mt-0.5 text-sm text-zinc-500">
            Bridge external communications to the Gateway Control Plane.
          </p>
        </div>
        <div className="hidden shrink-0 items-center gap-2 md:flex">
          {(
            [
              { id: 'whatsapp', label: 'WhatsApp', color: 'emerald' },
              { id: 'telegram', label: 'Telegram', color: 'blue' },
              { id: 'discord', label: 'Discord', color: 'indigo' },
              { id: 'imessage', label: 'iMessage', color: 'sky' },
              { id: 'slack', label: 'Slack', color: 'cyan' },
            ] as const
          )
            .filter((t) => coupledChannels[t.id]?.status === 'connected')
            .map((t) => (
              <span
                key={t.id}
                className="flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-300"
              >
                <span className={`h-1.5 w-1.5 rounded-full bg-${t.color}-500`} />
                {t.label}
              </span>
            ))}
        </div>
      </div>

      {/* Channel Tab Bar */}
      <div className="flex gap-1 rounded-xl border border-zinc-800 bg-zinc-900/80 p-1.5">
        {(
          [
            { id: 'whatsapp', label: 'WhatsApp', icon: '💬', color: 'emerald' },
            { id: 'telegram', label: 'Telegram', icon: '✈️', color: 'blue' },
            { id: 'discord', label: 'Discord', icon: '👾', color: 'indigo' },
            { id: 'imessage', label: 'iMessage', icon: '☁️', color: 'sky' },
            { id: 'slack', label: 'Slack', icon: '🟦', color: 'cyan' },
          ] as const
        ).map((tab) => {
          const status = coupledChannels[tab.id]?.status;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as ActiveTab)}
              className={`relative flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-all md:flex-none md:justify-start md:px-4 ${
                isActive
                  ? 'bg-zinc-800 text-white shadow-sm'
                  : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
              }`}
            >
              <span className="text-base">{tab.icon}</span>
              <span className="hidden sm:inline">{tab.label}</span>
              {status === 'connected' && (
                <span className={`ml-auto h-2 w-2 shrink-0 rounded-full bg-${tab.color}-500`} />
              )}
              {(status === 'pairing' || status === 'awaiting_code') && (
                <span className="ml-auto h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-500" />
              )}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {/* Main Panel */}
        <div className="space-y-4 xl:col-span-2">
          {/* Account Selector – bridge tabs only */}
          {activeBridgeTab && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
              <h4 className="mb-4 text-xs font-semibold tracking-widest text-zinc-400 uppercase">
                Account — {activeBridgeTab.toUpperCase()}
              </h4>
              <div className="flex flex-wrap gap-3">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={activeAccountSelectId} className="text-xs text-zinc-500">
                    Active
                  </label>
                  <select
                    id={activeAccountSelectId}
                    value={selectedBridgeAccount[activeBridgeTab]}
                    onChange={(e) =>
                      setSelectedBridgeAccount((prev) => ({
                        ...prev,
                        [activeBridgeTab]: e.target.value,
                      }))
                    }
                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white focus:border-zinc-500 focus:outline-none"
                  >
                    {accountOptions.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                  <label htmlFor={newAccountInputId} className="text-xs text-zinc-500">
                    Add Account
                  </label>
                  <div className="flex gap-2">
                    <input
                      id={newAccountInputId}
                      value={newBridgeAccountDraft[activeBridgeTab]}
                      onChange={(e) =>
                        setNewBridgeAccountDraft((prev) => ({
                          ...prev,
                          [activeBridgeTab]: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => e.key === 'Enter' && applyNewAccountId()}
                      placeholder="e.g. support"
                      className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                    />
                    <button
                      onClick={applyNewAccountId}
                      className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
                    >
                      Use
                    </button>
                  </div>
                </div>
              </div>
              {activeTab === 'whatsapp' && (
                <div className="mt-4 border-t border-zinc-800 pt-4">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={allowFromInputId} className="text-xs text-zinc-500">
                      Allow From{' '}
                      <span className="text-zinc-600">
                        — optional comma-separated sender filters
                      </span>
                    </label>
                    <div className="flex gap-2">
                      <input
                        id={allowFromInputId}
                        value={allowFromInput}
                        onChange={(e) => setAllowFromInput(e.target.value)}
                        placeholder="+49123, +49888, sales-team"
                        className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                      />
                      <button
                        onClick={saveAllowFrom}
                        disabled={isSavingAllowFrom}
                        className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isSavingAllowFrom ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Channel Handler */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
            {activeTab === 'whatsapp' && (
              <WhatsAppHandler
                channel={currentChannel}
                onStartPairing={startPairing}
                onDisconnect={disconnect}
                simMessage={simMessage}
                setSimMessage={setSimMessage}
                onSimulate={handleSimulate}
              />
            )}
            {activeTab === 'telegram' && (
              <TelegramHandler
                channel={currentChannel}
                onStartPairing={startPairing}
                onConfirmPairingCode={confirmTelegramPairingCode}
                onDisconnect={disconnect}
                pairingCode={pairingCode}
                setPairingCode={setPairingCode}
                isConfirmingCode={isConfirmingCode}
                token={inputToken}
                setToken={setInputToken}
                simMessage={simMessage}
                setSimMessage={setSimMessage}
                onSimulate={handleSimulate}
              />
            )}
            {activeTab === 'discord' && (
              <GenericChannelHandler
                channel={currentChannel}
                title="Discord Bot"
                icon="👾"
                description="Use a Discord Bot Token to relay server and DM messages."
                accent="indigo"
                token={inputToken}
                setToken={setInputToken}
                tokenPlaceholder="DISCORD_BOT_TOKEN_KEY"
                simMessage={simMessage}
                setSimMessage={setSimMessage}
                onStartPairing={startPairing}
                onDisconnect={disconnect}
                onSimulate={handleSimulate}
              />
            )}
            {activeTab === 'imessage' && (
              <GenericChannelHandler
                channel={currentChannel}
                title="iMessage Bridge"
                icon="☁️"
                description="Relay iMessages through a local smid-enabled macOS node."
                accent="sky"
                simMessage={simMessage}
                setSimMessage={setSimMessage}
                onStartPairing={startPairing}
                onDisconnect={disconnect}
                onSimulate={handleSimulate}
              />
            )}
            {activeTab === 'slack' && (
              <GenericChannelHandler
                channel={currentChannel}
                title="Slack Bot"
                icon="🟦"
                description="Connect a Slack Bot Token for channel and DM relay."
                accent="indigo"
                token={inputToken}
                setToken={setInputToken}
                tokenPlaceholder="SLACK_BOT_TOKEN"
                simMessage={simMessage}
                setSimMessage={setSimMessage}
                onStartPairing={startPairing}
                onDisconnect={disconnect}
                onSimulate={handleSimulate}
              />
            )}
          </div>
        </div>

        {/* Activity Log */}
        <div className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h4 className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">
              Activity Log
            </h4>
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
      </div>
    </div>
  );
};

export default ChannelPairing;
