import React, { useState } from 'react';
import type { Conversation, Message } from '../../../../types';
import { getPlatformMeta } from '../uiUtils';
import ChatMessageAttachment from './ChatMessageAttachment';
import { usePersona } from '../../personas/PersonaContext';

interface ChatMainPaneProps {
  activeConversation: Conversation | undefined;
  messages: Message[];
  isTyping?: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

const ChatMainPane: React.FC<ChatMainPaneProps> = ({
  activeConversation,
  messages,
  isTyping,
  scrollRef,
}) => {
  const activeMeta = activeConversation ? getPlatformMeta(activeConversation.channelType) : null;
  const { activePersona, personas, activePersonaId, setActivePersonaId } = usePersona();
  const [showPersonaDropdown, setShowPersonaDropdown] = useState(false);

  return (
    <>
      <header className="h-16 border-b border-zinc-800 px-6 flex items-center justify-between bg-zinc-950/80 backdrop-blur-2xl z-20">
        <div className="flex items-center space-x-4">
          {activeConversation ? (
            <>
              <div className="w-10 h-10 rounded-xl bg-violet-600/20 border border-violet-500/30 flex items-center justify-center text-violet-400">
                {activeMeta?.icon}
              </div>
              <div>
                <h3 className="text-sm font-bold text-white tracking-tight">{activeConversation.title}</h3>
                <div className="flex items-center space-x-2">
                  <span className="text-[9px] font-black text-zinc-600 uppercase tracking-widest">
                    ID:
                  </span>
                  <span className="text-[9px] font-mono text-zinc-500">
                    {activeConversation.id.slice(0, 8)}...
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className="text-zinc-500 text-sm font-medium">Conversation auswählen</div>
          )}
        </div>

        {/* Persona Switcher */}
        <div className="relative">
          <button
            onClick={() => setShowPersonaDropdown(!showPersonaDropdown)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border ${
              activePersona
                ? 'bg-indigo-600/15 border-indigo-500/30 text-indigo-300 hover:bg-indigo-600/25'
                : 'bg-zinc-800/50 border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600'
            }`}
          >
            <span>{activePersona?.emoji || '🤖'}</span>
            <span>{activePersona?.name || 'Default'}</span>
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
          </button>

          {showPersonaDropdown && (
            <div className="absolute right-0 top-full mt-1 w-56 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden z-50">
              <button
                onClick={() => { setActivePersonaId(null); setShowPersonaDropdown(false); }}
                className={`w-full text-left px-4 py-2.5 text-sm transition-colors flex items-center gap-2 ${
                  !activePersonaId ? 'bg-indigo-600/20 text-white' : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'
                }`}
              >
                <span>🤖</span>
                <span>Default (kein Persona)</span>
              </button>
              {personas.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { setActivePersonaId(p.id); setShowPersonaDropdown(false); }}
                  className={`w-full text-left px-4 py-2.5 text-sm transition-colors flex items-center gap-2 ${
                    activePersonaId === p.id ? 'bg-indigo-600/20 text-white' : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'
                  }`}
                >
                  <span>{p.emoji}</span>
                  <span className="truncate">{p.name}</span>
                </button>
              ))}
              {personas.length === 0 && (
                <div className="px-4 py-3 text-xs text-zinc-600">Keine Personas erstellt</div>
              )}
            </div>
          )}
        </div>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-6 space-y-6 bg-[radial-gradient(circle_at_top_right,_rgba(99,102,241,0.05),transparent)] scrollbar-thin"
      >
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center space-y-4 opacity-20">
            <div className="w-16 h-16 rounded-full border-2 border-dashed border-zinc-800 flex items-center justify-center">
              <svg className="w-8 h-8 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <span className="text-[9px] font-black uppercase tracking-[0.3em] text-zinc-500 text-center">
              Noch keine Nachrichten
            </span>
          </div>
        ) : (
          messages.map((message) => {
            const meta = getPlatformMeta(message.platform);
            return (
              <div
                key={message.id}
                className={`flex flex-col ${
                  message.role === 'user' ? 'items-end' : 'items-start'
                } animate-in fade-in slide-in-from-bottom-2 duration-300`}
              >
                <div className={`max-w-[80%] relative ${message.role === 'system' ? 'w-full max-w-none' : ''}`}>
                  {message.role !== 'system' && (
                    <div
                      className={`flex items-center space-x-2 mb-1 px-1 ${
                        message.role === 'user' ? 'flex-row-reverse space-x-reverse' : ''
                      }`}
                    >
                      <span className="text-[9px] font-bold text-zinc-700 uppercase">
                        {message.timestamp}
                      </span>
                      <span
                        className={`text-[8px] font-black uppercase px-1.5 py-0.5 rounded border ${meta.border} bg-zinc-900 ${meta.text}`}
                      >
                        {message.platform}
                      </span>
                    </div>
                  )}

                  <div
                    className={`transition-all duration-300 ${
                      message.role === 'agent'
                        ? 'bg-zinc-900 border border-zinc-800 shadow-xl rounded-2xl rounded-tl-none p-4'
                        : message.role === 'system'
                          ? 'bg-zinc-950 text-indigo-400 border border-indigo-500/10 text-center font-mono text-[9px] py-1.5 rounded uppercase tracking-widest'
                          : `${meta.bg} text-white shadow-lg rounded-2xl rounded-tr-none p-4`
                    }`}
                  >
                    <div
                      className={`text-sm leading-relaxed whitespace-pre-wrap ${
                        message.role === 'user' ? 'font-medium' : 'font-normal'
                      }`}
                    >
                      {message.content || (message.role === 'agent' ? '...' : '')}
                    </div>
                    {message.attachment && <ChatMessageAttachment attachment={message.attachment} />}
                  </div>
                </div>
              </div>
            );
          })
        )}
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
    </>
  );
};

export default ChatMainPane;
