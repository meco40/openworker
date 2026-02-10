
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChannelType, CoupledChannel } from '../types';
import { WhatsAppHandler } from './whatsapp/WhatsAppHandler';
import { TelegramHandler } from './telegram/TelegramHandler';
import { GenericChannelHandler } from './shared/GenericChannelHandler';

interface ChannelPairingProps {
  coupledChannels: Record<string, CoupledChannel>;
  onUpdateCoupling: (id: string, update: Partial<CoupledChannel>) => void;
  onSimulateIncoming?: (content: string, platform: ChannelType) => void;
}

type ActiveTab = 'whatsapp' | 'telegram' | 'discord' | 'imessage';

const ChannelPairing: React.FC<ChannelPairingProps> = ({ coupledChannels, onUpdateCoupling, onSimulateIncoming }) => {
  const [activeTab, setActiveTab] = useState<ActiveTab>('whatsapp');
  const [pairingLogs, setPairingLogs] = useState<string[]>([]);
  const [inputToken, setInputToken] = useState('');
  const [simMessage, setSimMessage] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [isConfirmingCode, setIsConfirmingCode] = useState(false);
  const [telegramTransport, setTelegramTransport] = useState<'webhook' | 'polling' | null>(null);
  const telegramPollingErrorLogged = useRef(false);

  const currentChannel = coupledChannels[activeTab];

  const addLog = useCallback((msg: string) => {
    setPairingLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev.slice(0, 9)]);
  }, []);

  const startPairing = async () => {
    setPairingCode('');
    setIsConfirmingCode(false);
    onUpdateCoupling(activeTab, { status: 'pairing' });
    addLog(`Initiating pairing sequence for ${activeTab.toUpperCase()}...`);

    try {
      const response = await fetch('/api/channels/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: activeTab,
          token: activeTab === 'telegram' || activeTab === 'discord' ? inputToken : undefined,
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
      if (nextStatus === 'awaiting_code') {
        addLog('Token valid. Send a Telegram message to the bot to receive the pairing code.');
        if (activeTab === 'telegram' && payload.transport === 'polling') {
          addLog('Webhook URL unavailable. Using Telegram polling fallback.');
        }
      } else {
        addLog(`Success! ${activeTab.toUpperCase()} bridge established (${payload.peerName}).`);
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
    addLog(`Disconnecting ${activeTab.toUpperCase()} bridge...`);
    try {
      const response = await fetch('/api/channels/pair', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: activeTab }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || 'Disconnect failed.');
      }
      addLog(`${activeTab.toUpperCase()} bridge dismantled successfully.`);
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

  useEffect(() => {
    const telegramChannel = coupledChannels.telegram;
    if (!telegramChannel || telegramChannel.status !== 'awaiting_code' || telegramTransport !== 'polling') {
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
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <div className="flex flex-col">
        <h2 className="text-xl font-bold text-white tracking-tight">Messenger Coupling</h2>
        <p className="text-sm text-zinc-500">Bridge external communications to the Gateway Control Plane.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden shadow-xl p-4 space-y-2">
           <h4 className="text-[10px] font-black uppercase text-zinc-600 mb-4 px-2 tracking-widest">Available Nodes</h4>
           {[
             { id: 'whatsapp', label: 'WhatsApp', icon: '💬', color: 'emerald' },
             { id: 'telegram', label: 'Telegram', icon: '✈️', color: 'blue' },
             { id: 'discord', label: 'Discord Bot', icon: '👾', color: 'indigo' },
             { id: 'imessage', label: 'iMessage', icon: '☁️', color: 'sky' },
           ].map((tab) => (
             <button
               key={tab.id}
               onClick={() => setActiveTab(tab.id as ActiveTab)}
               className={`w-full flex items-center justify-between p-3 rounded-lg text-xs font-bold transition-all ${
                 activeTab === tab.id 
                 ? `bg-zinc-800 text-${tab.color}-500 shadow-inner` 
                 : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
               }`}
             >
               <span className="flex items-center space-x-3">
                 <span>{tab.icon}</span>
                 <span>{tab.label}</span>
               </span>
               <div className={`w-1.5 h-1.5 rounded-full ${coupledChannels[tab.id].status === 'connected' ? `bg-${tab.color}-500` : 'bg-zinc-800'}`} />
             </button>
           ))}
        </div>

        <div className="lg:col-span-2 space-y-6">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden shadow-2xl min-h-[450px] flex flex-col items-center justify-center text-center p-10">
              {activeTab === 'whatsapp' && (
                <WhatsAppHandler channel={currentChannel} onStartPairing={startPairing} onDisconnect={disconnect} simMessage={simMessage} setSimMessage={setSimMessage} onSimulate={handleSimulate} />
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
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 flex flex-col shadow-xl">
           <h4 className="text-[10px] font-black text-white uppercase tracking-widest mb-6">Security Context</h4>
           <div className="bg-black border border-zinc-800 rounded-lg p-3 font-mono text-[9px] space-y-2 h-[250px] overflow-y-auto">
              {pairingLogs.map((log, i) => <div key={i} className="text-zinc-500">{log}</div>)}
           </div>
        </div>
      </div>
    </div>
  );
};

export default ChannelPairing;
