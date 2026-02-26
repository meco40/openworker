import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ACCOUNT_ID_PATTERN, BRIDGE_TABS, mapBridgeStatusToUiStatus, normalizeAccountId } from './helpers';
import type {
  ActiveTab,
  BridgeAccount,
  BridgeTab,
  ChannelPairingProps,
  ChannelStateResponse,
  WhatsAppAccountsResponse,
} from './types';

type UseChannelPairingControllerParams = Pick<
  ChannelPairingProps,
  'coupledChannels' | 'onUpdateCoupling' | 'onSimulateIncoming'
>;

export function useChannelPairingController({
  coupledChannels,
  onUpdateCoupling,
  onSimulateIncoming,
}: UseChannelPairingControllerParams) {
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
      setAllowFromInput(Array.isArray(entry?.allowFrom) ? entry.allowFrom.join(', ') : '');
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

    void pollUpdates();
    const timer = setInterval(() => {
      void pollUpdates();
    }, 3000);

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

  return {
    activeTab,
    setActiveTab,
    pairingLogs,
    inputToken,
    setInputToken,
    simMessage,
    setSimMessage,
    pairingCode,
    setPairingCode,
    isConfirmingCode,
    isBridgeTab,
    activeBridgeTab,
    activeAccountSelectId,
    newAccountInputId,
    allowFromInputId,
    selectedBridgeAccount,
    setSelectedBridgeAccount,
    newBridgeAccountDraft,
    setNewBridgeAccountDraft,
    allowFromInput,
    setAllowFromInput,
    isSavingAllowFrom,
    accountOptions,
    currentChannel,
    startPairing,
    confirmTelegramPairingCode,
    disconnect,
    applyNewAccountId,
    saveAllowFrom,
    handleSimulate,
  };
}
