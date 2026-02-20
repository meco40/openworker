import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChannelType, CoupledChannel } from '../types';
import { WhatsAppHandler } from './whatsapp/WhatsAppHandler';
import { TelegramHandler } from './telegram/TelegramHandler';
import { GenericChannelHandler } from './shared/GenericChannelHandler';

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
        addLog(`Success! ${activeTab.toUpperCase()} bridge established${suffix} (${payload.peerName}).`);
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
      await refreshBridgeAccounts();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      addLog(`Disconnect warning: ${message} (local state cleared anyway)`);
    }
    onUpdateCoupling(activeTab, { status: 'idle', peerName: undefined, connectedAt: undefined });
    setInputToken('');
    setPairingCode('');
    setIsConfirmingCode(false);
    if (activeTab === 'telegram') {
      setTelegramTransport(null);
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
    <div className="mx-auto max-w-5xl space-y-6 pb-12">
      <div className="flex flex-col">
        <h2 className="text-xl font-bold tracking-tight text-white">Messenger Coupling</h2>
        <p className="text-sm text-zinc-500">
          Bridge external communications to the Gateway Control Plane.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
        <div className="space-y-2 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 p-4 shadow-xl">
          <h4 className="mb-4 px-2 text-[10px] font-black tracking-widest text-zinc-600 uppercase">
            Available Nodes
          </h4>
          {[
            { id: 'whatsapp', label: 'WhatsApp', icon: '💬', color: 'emerald' },
            { id: 'telegram', label: 'Telegram', icon: '✈️', color: 'blue' },
            { id: 'discord', label: 'Discord Bot', icon: '👾', color: 'indigo' },
            { id: 'imessage', label: 'iMessage', icon: '☁️', color: 'sky' },
            { id: 'slack', label: 'Slack', icon: '🟦', color: 'cyan' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as ActiveTab)}
              className={`flex w-full items-center justify-between rounded-lg p-3 text-xs font-bold transition-all ${
                activeTab === tab.id
                  ? `bg-zinc-800 text-${tab.color}-500 shadow-inner`
                  : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
              }`}
            >
              <span className="flex items-center space-x-3">
                <span>{tab.icon}</span>
                <span>{tab.label}</span>
              </span>
              <div
                className={`h-1.5 w-1.5 rounded-full ${coupledChannels[tab.id].status === 'connected' ? `bg-${tab.color}-500` : 'bg-zinc-800'}`}
              />
            </button>
          ))}
        </div>

        <div className="space-y-6 lg:col-span-2">
          {activeBridgeTab && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 shadow-xl">
              <div className="mb-3 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                Account Selector ({activeBridgeTab.toUpperCase()})
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <label className="flex flex-col gap-1 text-left">
                  <span className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
                    Active Account
                  </span>
                  <select
                    value={selectedBridgeAccount[activeBridgeTab]}
                    onChange={(event) =>
                      setSelectedBridgeAccount((previous) => ({
                        ...previous,
                        [activeBridgeTab]: event.target.value,
                      }))
                    }
                    className="rounded-lg border border-zinc-800 bg-zinc-950 p-2 text-xs text-white focus:border-emerald-500 focus:outline-none"
                  >
                    {accountOptions.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-left">
                  <span className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
                    New Account
                  </span>
                  <input
                    value={newBridgeAccountDraft[activeBridgeTab]}
                    onChange={(event) =>
                      setNewBridgeAccountDraft((previous) => ({
                        ...previous,
                        [activeBridgeTab]: event.target.value,
                      }))
                    }
                    placeholder="support"
                    className="rounded-lg border border-zinc-800 bg-zinc-950 p-2 text-xs text-white focus:border-emerald-500 focus:outline-none"
                  />
                </label>

                <div className="flex items-end">
                  <button
                    onClick={applyNewAccountId}
                    className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-xs font-bold tracking-widest text-zinc-100 uppercase hover:bg-zinc-700"
                  >
                    Use Account
                  </button>
                </div>
              </div>

              {activeTab === 'whatsapp' && (
                <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                  <div className="mb-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                    Allow From (Optional)
                  </div>
                  <p className="mb-2 text-left text-[11px] text-zinc-500">
                    Comma-separated sender filters, e.g. <code>+49123, sales-team</code>
                  </p>
                  <div className="flex gap-2">
                    <input
                      value={allowFromInput}
                      onChange={(event) => setAllowFromInput(event.target.value)}
                      placeholder="+49123, +49888"
                      className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-xs text-white focus:border-emerald-500 focus:outline-none"
                    />
                    <button
                      onClick={saveAllowFrom}
                      disabled={isSavingAllowFrom}
                      className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold tracking-widest text-white uppercase hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isSavingAllowFrom ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex min-h-[450px] flex-col items-center justify-center overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 p-10 text-center shadow-2xl">
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
                description="Use a Discord Bot Token to relay server or DM messages."
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

        <div className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
          <h4 className="mb-6 text-[10px] font-black tracking-widest text-white uppercase">
            Security Context
          </h4>
          <div className="h-[250px] space-y-2 overflow-y-auto rounded-lg border border-zinc-800 bg-black p-3 font-mono text-[9px]">
            {pairingLogs.map((log, index) => (
              <div key={index} className="text-zinc-500">
                {log}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChannelPairing;

