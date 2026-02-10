
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Message, ChannelType, CoupledChannel } from '../types';

interface ChatInterfaceProps {
  coupledChannels: Record<string, CoupledChannel>;
  messages: Message[];
  onSendMessage: (content: string, platform: ChannelType) => void;
  isTyping?: boolean;
}

const ChatInterface: React.FC<ChatInterfaceProps> = ({ coupledChannels, messages, onSendMessage, isTyping }) => {
  const [input, setInput] = useState('');
  const [selectedPlatform, setSelectedPlatform] = useState<ChannelType | 'GLOBAL'>(ChannelType.WEBCHAT);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping]);

  const handleSend = () => {
    if (!input.trim()) return;
    const platform = selectedPlatform === 'GLOBAL' ? ChannelType.WEBCHAT : selectedPlatform;
    onSendMessage(input, platform);
    setInput('');
  };

  const platformMeta: Record<string, { color: string, icon: string, bg: string, text: string, border: string }> = {
    [ChannelType.WHATSAPP]: { color: 'emerald', icon: '💬', bg: 'bg-emerald-600', text: 'text-emerald-500', border: 'border-emerald-500/20' },
    [ChannelType.TELEGRAM]: { color: 'blue', icon: '✈️', bg: 'bg-blue-600', text: 'text-blue-500', border: 'border-blue-500/20' },
    [ChannelType.DISCORD]: { color: 'indigo', icon: '👾', bg: 'bg-indigo-600', text: 'text-indigo-500', border: 'border-indigo-500/20' },
    [ChannelType.IMESSAGE]: { color: 'sky', icon: '☁️', bg: 'bg-sky-600', text: 'text-sky-500', border: 'border-sky-500/20' },
    [ChannelType.WEBCHAT]: { color: 'zinc', icon: '🏠', bg: 'bg-zinc-700', text: 'text-zinc-400', border: 'border-zinc-700/20' },
    'GLOBAL': { color: 'violet', icon: '🌐', bg: 'bg-violet-600', text: 'text-violet-400', border: 'border-violet-500/20' }
  };

  const filteredMessages = useMemo(() => {
    if (selectedPlatform === 'GLOBAL') return messages;
    return messages.filter(m => m.platform === selectedPlatform || m.role === 'system');
  }, [messages, selectedPlatform]);

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a] border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl relative">
      <header className="h-16 border-b border-zinc-800 px-6 flex items-center justify-between bg-zinc-950/80 backdrop-blur-2xl z-20">
        <div className="flex items-center space-x-4">
          <div className="w-10 h-10 rounded-xl bg-violet-600/20 border border-violet-500/30 flex items-center justify-center text-violet-400">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-bold text-white tracking-tight">
              {selectedPlatform === 'GLOBAL' ? 'Global Communication Feed' : `${selectedPlatform} Bridge`}
            </h3>
            <div className="flex items-center space-x-2">
              <span className="text-[9px] font-black text-zinc-600 uppercase tracking-widest">Mirroring State:</span>
              <div className="flex space-x-1.5 items-center">
                 <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                 <span className="text-[9px] font-mono text-emerald-500 uppercase">Synchronized</span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-4">
          <button 
            onClick={() => setSelectedPlatform('GLOBAL')}
            className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
              selectedPlatform === 'GLOBAL' ? 'bg-violet-600 text-white shadow-lg' : 'text-zinc-600 hover:text-zinc-400'
            }`}
          >
            Global View
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6 bg-[radial-gradient(circle_at_top_right,_rgba(99,102,241,0.05),transparent)] scrollbar-thin">
        {filteredMessages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center space-y-4 opacity-20">
            <div className="w-16 h-16 rounded-full border-2 border-dashed border-zinc-800 flex items-center justify-center">
               <svg className="w-8 h-8 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
            </div>
            <span className="text-[9px] font-black uppercase tracking-[0.3em] text-zinc-500 text-center">Bridge Link: Idle<br/>No active signals in this channel</span>
          </div>
        ) : filteredMessages.map((m) => {
          const meta = platformMeta[m.platform] || platformMeta[ChannelType.WEBCHAT];
          return (
            <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-2 duration-300`}>
              <div className={`max-w-[80%] relative ${m.role === 'system' ? 'w-full max-w-none' : ''}`}>
                
                {m.role !== 'system' && (
                  <div className={`flex items-center space-x-2 mb-1 px-1 ${m.role === 'user' ? 'flex-row-reverse space-x-reverse' : ''}`}>
                     <span className="text-[9px] font-bold text-zinc-700 uppercase">{m.timestamp}</span>
                     <span className={`text-[8px] font-black uppercase px-1.5 py-0.5 rounded border ${meta.border} bg-zinc-900 ${meta.text}`}>
                        {m.platform}
                     </span>
                  </div>
                )}

                <div className={`transition-all duration-300 ${
                  m.role === 'agent' ? 'bg-zinc-900 border border-zinc-800 shadow-xl rounded-2xl rounded-tl-none p-4' :
                  m.role === 'system' ? 'bg-zinc-950 text-indigo-400 border border-indigo-500/10 text-center font-mono text-[9px] py-1.5 rounded uppercase tracking-widest' :
                  `${meta.bg} text-white shadow-lg rounded-2xl rounded-tr-none p-4`
                }`}>
                  <div className={`text-sm leading-relaxed whitespace-pre-wrap ${m.role === 'user' ? 'font-medium' : 'font-normal'}`}>
                    {m.content || (m.role === 'agent' ? '...' : '')}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {isTyping && (
           <div className="flex flex-col items-start animate-pulse">
             <div className="bg-zinc-900 border border-zinc-800 rounded-2xl rounded-tl-none p-4 px-6">
                <div className="flex space-x-1">
                   <div className="w-1.5 h-1.5 bg-zinc-600 rounded-full animate-bounce [animation-delay:-0.3s]" />
                   <div className="w-1.5 h-1.5 bg-zinc-600 rounded-full animate-bounce [animation-delay:-0.15s]" />
                   <div className="w-1.5 h-1.5 bg-zinc-600 rounded-full animate-bounce" />
                </div>
             </div>
           </div>
        )}
      </div>

      <footer className="p-6 bg-zinc-950/80 backdrop-blur-2xl border-t border-zinc-800 z-20">
        <div className="flex flex-col space-y-4">
          <div className="flex items-center space-x-2 overflow-x-auto pb-2 scrollbar-hide">
            {[ChannelType.WEBCHAT, ChannelType.WHATSAPP, ChannelType.TELEGRAM, ChannelType.DISCORD, ChannelType.IMESSAGE].map((platform) => {
              const meta = platformMeta[platform] || platformMeta[ChannelType.WEBCHAT];
              const pKey = platform.toLowerCase();
              const isCoupled = platform === ChannelType.WEBCHAT || (coupledChannels[pKey]?.status === 'connected');
              
              return (
                <button
                  key={platform}
                  disabled={!isCoupled}
                  onClick={() => setSelectedPlatform(platform)}
                  className={`flex items-center space-x-2 px-3 py-1.5 rounded-full border transition-all duration-300 whitespace-nowrap ${
                    selectedPlatform === platform
                      ? `${meta.border} bg-zinc-900 shadow-lg scale-105`
                      : 'bg-transparent border-transparent opacity-30 grayscale hover:opacity-100 hover:grayscale-0'
                  } ${!isCoupled ? 'cursor-not-allowed' : ''}`}
                >
                  <span className="text-xs">{meta.icon}</span>
                  <span className={`text-[10px] font-black uppercase tracking-widest ${selectedPlatform === platform ? meta.text : 'text-zinc-500'}`}>
                    {platform}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="relative group">
            <div className="relative flex items-center space-x-3 bg-zinc-900 border border-zinc-800 rounded-xl p-2 pl-5 focus-within:border-zinc-700 transition-all">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder={`Dispatch via ${selectedPlatform === 'GLOBAL' ? 'WebChat' : selectedPlatform}...`}
                className="flex-1 bg-transparent text-sm text-white focus:outline-none placeholder-zinc-700 font-medium py-2"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                className={`p-2.5 rounded-lg transition-all ${
                  input.trim() 
                    ? `bg-violet-600 text-white shadow-lg active:scale-95` 
                    : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                }`}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default ChatInterface;
