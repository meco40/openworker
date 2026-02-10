
import React, { useState } from 'react';
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

  const currentChannel = coupledChannels[activeTab];

  const addLog = (msg: string) => {
    setPairingLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev.slice(0, 9)]);
  };

  const startPairing = async () => {
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

      onUpdateCoupling(activeTab, {
        status: 'connected',
        peerName: payload.peerName,
        connectedAt: payload.connectedAt,
      });
      addLog(`Success! ${activeTab.toUpperCase()} bridge established (${payload.peerName}).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      onUpdateCoupling(activeTab, { status: 'idle', peerName: undefined, connectedAt: undefined });
      addLog(`Pairing failed: ${message}`);
    }
  };

  const disconnect = () => {
    onUpdateCoupling(activeTab, { status: 'idle', peerName: undefined, connectedAt: undefined });
    addLog(`Dismantled ${activeTab.toUpperCase()} bridge.`);
    setInputToken('');
  };

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
                <TelegramHandler channel={currentChannel} onStartPairing={startPairing} onDisconnect={disconnect} token={inputToken} setToken={setInputToken} simMessage={simMessage} setSimMessage={setSimMessage} onSimulate={handleSimulate} />
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
