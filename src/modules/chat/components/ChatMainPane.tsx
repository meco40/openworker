import React, { useEffect, useRef, useState } from 'react';
import type {
  ChatApprovalDecision,
  ChatStreamDebugState,
  Conversation,
  Message,
  MessageApprovalRequest,
} from '@/shared/domain/types';
import { getPlatformMeta } from '@/modules/chat/uiUtils';
import ChatMessageAttachment from '@/modules/chat/components/ChatMessageAttachment';
import { usePersona } from '@/modules/personas/PersonaContext';

interface ChatMainPaneProps {
  activeConversation: Conversation | undefined;
  messages: Message[];
  isTyping?: boolean;
  chatStreamDebug: ChatStreamDebugState;
  onRespondApproval: (
    message: Message,
    approvalRequest: MessageApprovalRequest,
    decision: ChatApprovalDecision,
  ) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

const ChatMainPane: React.FC<ChatMainPaneProps> = ({
  activeConversation,
  messages,
  isTyping,
  chatStreamDebug,
  onRespondApproval,
  scrollRef,
}) => {
  const activeMeta = activeConversation ? getPlatformMeta(activeConversation.channelType) : null;
  const { activePersona, personas, activePersonaId, setActivePersonaId } = usePersona();
  const [showPersonaDropdown, setShowPersonaDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const streamDebugLabel =
    chatStreamDebug.phase === 'running'
      ? chatStreamDebug.transport === 'live-delta'
        ? 'Stream: LIVE-Delta aktiv'
        : 'Stream: wartet auf Delta'
      : chatStreamDebug.phase === 'done'
        ? chatStreamDebug.transport === 'live-delta'
          ? 'Letzte Antwort: LIVE-Delta'
          : 'Letzte Antwort: final-only'
        : chatStreamDebug.phase === 'error'
          ? `Stream: Fehler${chatStreamDebug.message ? ` (${chatStreamDebug.message})` : ''}`
          : 'Stream: idle';
  const streamDebugClass =
    chatStreamDebug.transport === 'live-delta'
      ? 'border-emerald-500/30 bg-emerald-600/15 text-emerald-300'
      : chatStreamDebug.phase === 'error'
        ? 'border-rose-500/30 bg-rose-600/15 text-rose-300'
        : 'border-amber-500/30 bg-amber-600/15 text-amber-300';

  useEffect(() => {
    if (!showPersonaDropdown) {
      return;
    }

    const onDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!dropdownRef.current?.contains(target || null)) {
        setShowPersonaDropdown(false);
      }
    };

    document.addEventListener('mousedown', onDocumentMouseDown);
    return () => {
      document.removeEventListener('mousedown', onDocumentMouseDown);
    };
  }, [showPersonaDropdown]);

  return (
    <>
      <header className="z-20 flex h-16 items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-6 backdrop-blur-2xl">
        <div className="flex items-center space-x-4">
          {activeConversation ? (
            <>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-600/20 text-violet-400">
                {activeMeta?.icon}
              </div>
              <div>
                <h3 className="text-sm font-bold tracking-tight text-white">
                  {activeConversation.title}
                </h3>
                <div className="flex items-center space-x-2">
                  <span className="text-[9px] font-black tracking-widest text-zinc-600 uppercase">
                    ID:
                  </span>
                  <span className="font-mono text-[9px] text-zinc-500">
                    {activeConversation.id.slice(0, 8)}...
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className="text-sm font-medium text-zinc-500">Conversation auswählen</div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div
            className={`rounded-lg border px-2 py-1 text-[10px] font-semibold ${streamDebugClass}`}
          >
            {streamDebugLabel}
          </div>

          {/* Persona Switcher */}
          <div ref={dropdownRef} className="relative">
            <button
              onClick={() => setShowPersonaDropdown(!showPersonaDropdown)}
              data-testid="persona-dropdown-toggle"
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all ${
                activePersona
                  ? 'border-indigo-500/30 bg-indigo-600/15 text-indigo-300 hover:bg-indigo-600/25'
                  : 'border-zinc-700 bg-zinc-800/50 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300'
              }`}
            >
              <span>{activePersona?.emoji || '🤖'}</span>
              <span>{activePersona?.name || 'Default'}</span>
              <svg
                className="h-3 w-3"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>

            {showPersonaDropdown && (
              <div
                data-testid="persona-dropdown-menu"
                className="absolute top-full right-0 z-50 mt-1 w-56 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
              >
                <button
                  onClick={() => {
                    setActivePersonaId(null);
                    setShowPersonaDropdown(false);
                  }}
                  className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors ${
                    !activePersonaId
                      ? 'bg-indigo-600/20 text-white'
                      : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'
                  }`}
                >
                  <span>🤖</span>
                  <span>Default (kein Persona)</span>
                </button>
                {personas.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setActivePersonaId(p.id);
                      setShowPersonaDropdown(false);
                    }}
                    className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors ${
                      activePersonaId === p.id
                        ? 'bg-indigo-600/20 text-white'
                        : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'
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
        </div>
      </header>

      <div
        ref={scrollRef}
        className="scrollbar-thin flex-1 space-y-6 overflow-y-auto bg-[radial-gradient(circle_at_top_right,_rgba(99,102,241,0.05),transparent)] p-6"
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center space-y-4 opacity-20">
            <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-dashed border-zinc-800">
              <svg
                className="h-8 w-8 text-zinc-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <span className="text-center text-[9px] font-black tracking-[0.3em] text-zinc-500 uppercase">
              Noch keine Nachrichten
            </span>
          </div>
        ) : (
          messages.map((message) => {
            const meta = getPlatformMeta(message.platform);
            const approvalRequest = message.approvalRequest;
            return (
              <div
                key={message.id}
                data-testid={message.role === 'agent' ? 'chat-message-agent' : undefined}
                className={`flex flex-col ${
                  message.role === 'user' ? 'items-end' : 'items-start'
                } animate-in fade-in slide-in-from-bottom-2 duration-300`}
              >
                <div
                  className={`relative max-w-[80%] ${message.role === 'system' ? 'w-full max-w-none' : ''}`}
                >
                  {message.role !== 'system' && (
                    <div
                      className={`mb-1 flex items-center space-x-2 px-1 ${
                        message.role === 'user' ? 'flex-row-reverse space-x-reverse' : ''
                      }`}
                    >
                      <span className="text-[9px] font-bold text-zinc-700 uppercase">
                        {message.timestamp}
                      </span>
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[8px] font-black uppercase ${meta.border} bg-zinc-900 ${meta.text}`}
                      >
                        {message.platform}
                      </span>
                    </div>
                  )}

                  <div
                    className={`transition-all duration-300 ${
                      message.role === 'agent'
                        ? 'rounded-2xl rounded-tl-none border border-zinc-800 bg-zinc-900 p-4 shadow-xl'
                        : message.role === 'system'
                          ? 'rounded border border-indigo-500/10 bg-zinc-950 py-1.5 text-center font-mono text-[9px] tracking-widest text-indigo-400 uppercase'
                          : `${meta.bg} rounded-2xl rounded-tr-none p-4 text-white shadow-lg`
                    }`}
                  >
                    <div
                      className={`text-sm leading-relaxed whitespace-pre-wrap ${
                        message.role === 'user' ? 'font-medium' : 'font-normal'
                      }`}
                    >
                      {message.content || (message.role === 'agent' ? '...' : '')}
                    </div>
                    {message.attachment && (
                      <ChatMessageAttachment attachment={message.attachment} />
                    )}
                    {approvalRequest && (
                      <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
                        {approvalRequest.prompt && (
                          <div className="mb-2 text-xs leading-relaxed whitespace-pre-wrap text-amber-100">
                            {approvalRequest.prompt}
                          </div>
                        )}

                        {!message.approvalResolved ? (
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                onRespondApproval(message, approvalRequest, 'approve_once')
                              }
                              disabled={message.approvalSubmitting}
                              className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-60"
                            >
                              Approve once
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                onRespondApproval(message, approvalRequest, 'approve_always')
                              }
                              disabled={message.approvalSubmitting}
                              className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1 text-[10px] font-semibold text-indigo-300 transition hover:bg-indigo-500/20 disabled:opacity-60"
                            >
                              Approve always
                            </button>
                            <button
                              type="button"
                              onClick={() => onRespondApproval(message, approvalRequest, 'deny')}
                              disabled={message.approvalSubmitting}
                              className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[10px] font-semibold text-rose-300 transition hover:bg-rose-500/20 disabled:opacity-60"
                            >
                              Deny
                            </button>
                          </div>
                        ) : (
                          <div className="text-[11px] text-zinc-400">
                            {message.approvalResolved === 'approve_once'
                              ? 'Genehmigt (einmal).'
                              : message.approvalResolved === 'approve_always'
                                ? 'Genehmigt (immer) und Policy gespeichert.'
                                : 'Abgelehnt.'}
                          </div>
                        )}

                        {message.approvalError && (
                          <div className="mt-2 text-[11px] text-rose-300">
                            {message.approvalError}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
        {isTyping && (
          <div className="flex animate-pulse flex-col items-start">
            <div className="rounded-2xl rounded-tl-none border border-zinc-800 bg-zinc-900 p-4 px-6">
              <div className="flex space-x-1">
                <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-600 [animation-delay:-0.3s]" />
                <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-600 [animation-delay:-0.15s]" />
                <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-600" />
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default ChatMainPane;
