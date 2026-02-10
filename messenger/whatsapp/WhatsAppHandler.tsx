
import React from 'react';
import { CoupledChannel } from '../../types';

interface WhatsAppHandlerProps {
  channel: CoupledChannel;
  onStartPairing: () => void;
  onDisconnect: () => void;
  simMessage: string;
  setSimMessage: (val: string) => void;
  onSimulate: () => void;
}

export const WhatsAppHandler: React.FC<WhatsAppHandlerProps> = ({ 
  channel, onStartPairing, onDisconnect, simMessage, setSimMessage, onSimulate 
}) => {
  if (channel.status === 'idle') {
    return (
      <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-sm">
        <div className="w-16 h-16 bg-emerald-500/10 text-emerald-500 rounded-2xl flex items-center justify-center mx-auto shadow-xl text-3xl">💬</div>
        <h3 className="text-xl font-bold text-white">WhatsApp Integration</h3>
        <p className="text-zinc-500 text-sm leading-relaxed">Scan the QR code to link your account via Multi-Device protocol.</p>
        <button onClick={onStartPairing} className="w-full py-4 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg transition-all uppercase tracking-widest shadow-lg">Establish Bridge</button>
      </div>
    );
  }

  if (channel.status === 'pairing') {
    return (
      <div className="space-y-6 flex flex-col items-center">
        <div className="w-48 h-48 bg-white p-4 rounded-xl shadow-2xl relative overflow-hidden">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=openclaw-wa-link" className="w-full h-full" alt="QR" />
          <div className="absolute inset-0 bg-white/40 backdrop-blur-sm flex items-center justify-center">
            <div className="w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          </div>
        </div>
        <div className="text-emerald-500 font-mono text-xs font-bold uppercase">Handshaking...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500 w-full max-w-sm">
      <div className="w-20 h-20 bg-emerald-500 text-white rounded-full flex items-center justify-center mx-auto shadow-2xl">
        <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
      </div>
      <div>
        <h3 className="text-2xl font-bold text-white">WhatsApp Bridge Live</h3>
        <p className="text-zinc-500 text-xs font-mono uppercase mt-1">Status: E2E_ENCRYPTED_STREAM</p>
      </div>
      <div className="mt-8 p-4 bg-zinc-950 border border-emerald-500/20 rounded-xl space-y-4">
        <div className="text-[10px] font-black uppercase text-emerald-500 tracking-widest flex items-center justify-center space-x-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span>Input Simulator</span>
        </div>
        <div className="flex space-x-2">
          <input value={simMessage} onChange={e => setSimMessage(e.target.value)} placeholder="Message from mobile..." className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-emerald-500 transition-all" />
          <button onClick={onSimulate} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-xs font-bold uppercase transition-all">Push</button>
        </div>
      </div>
      <button onClick={onDisconnect} className="w-full py-3 border border-rose-900/50 text-rose-500 text-[10px] font-bold rounded uppercase hover:bg-rose-950/20 transition-all tracking-widest">Dismantle Link</button>
    </div>
  );
};
