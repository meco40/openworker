'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PersonaSummary } from '../../../server/personas/personaTypes';
import type {
  RoomInterventionEvent,
  RoomMember,
  RoomMemberStatus,
  RoomMessage,
  RoomMetricsEvent,
  RoomRunStatusEvent,
  RoomState,
  RoomSummary,
} from '../types';

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

interface RoomDetailPanelProps {
  room: RoomSummary | null;
  state: RoomState | null;
  members: RoomMember[];
  messages: RoomMessage[];
  memberStatus: Record<string, RoomMemberStatus>;
  activeRoomCountsByPersona: Record<string, number>;
  liveRunStatus: RoomRunStatusEvent | null;
  interventions: RoomInterventionEvent[];
  metrics: RoomMetricsEvent | null;
  personas: PersonaSummary[];
  loading: boolean;
  onStart: () => void;
  onStop: () => void;
  onRefresh: () => void;
  onDelete: () => void;
  onAddMember: (personaId: string, roleLabel: string, modelOverride: string) => void;
  onRemoveMember: (personaId: string) => void;
  onSendMessage: (content: string) => void;
}

export function RoomDetailPanel({
  room,
  state,
  members,
  messages,
  memberStatus,
  activeRoomCountsByPersona,
  liveRunStatus,
  interventions,
  metrics,
  personas,
  loading,
  onStart,
  onStop,
  onRefresh,
  onDelete,
  onAddMember,
  onRemoveMember,
  onSendMessage,
}: RoomDetailPanelProps) {
  const [selectedPersonaId, setSelectedPersonaId] = useState('');
  const [roleLabel, setRoleLabel] = useState('');
  const [modelOverride, setModelOverride] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const availablePersonas = useMemo(() => {
    const memberSet = new Set(members.map((item) => item.personaId));
    return personas.filter((persona) => !memberSet.has(persona.id));
  }, [personas, members]);

  const personaMap = useMemo(() => {
    const map = new Map<string, PersonaSummary>();
    for (const p of personas) {
      map.set(p.id, p);
    }
    return map;
  }, [personas]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleSendMessage = useCallback(async () => {
    const content = chatInput.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      onSendMessage(content);
      setChatInput('');
    } finally {
      setSending(false);
    }
  }, [chatInput, sending, onSendMessage]);

  if (!room) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-600">
        <div className="text-center space-y-2">
          <div className="text-4xl">🏠</div>
          <div className="text-sm">Wähle oder erstelle einen Room</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="p-4 border-b border-zinc-800 flex items-center gap-3">
        <span className="text-2xl">🏠</span>
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-bold text-white truncate">{room.name}</h3>
          <div className="text-xs text-zinc-500">
            {room.goalMode} • {state?.routingProfileId || room.routingProfileId}
          </div>
          {room.description && (
            <div className="text-xs text-zinc-400 mt-0.5 truncate" title={room.description}>
              {room.description}
            </div>
          )}
        </div>

        <span
          className={`text-[10px] px-2 py-1 rounded-full uppercase tracking-wider ${
            (liveRunStatus?.runState || state?.runState) === 'running'
              ? 'bg-emerald-600/20 text-emerald-300'
              : (liveRunStatus?.runState || state?.runState) === 'degraded'
                ? 'bg-amber-700/30 text-amber-300'
                : 'bg-zinc-700/60 text-zinc-300'
          }`}
        >
          {liveRunStatus?.runState || state?.runState || room.runState}
        </span>

        <button
          onClick={onRefresh}
          className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
        >
          Refresh
        </button>
        <button
          onClick={onDelete}
          className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-rose-700 text-zinc-100"
        >
          Delete
        </button>
        {state?.runState === 'running' ? (
          <button
            onClick={onStop}
            className="px-3 py-1.5 text-xs rounded-lg bg-rose-600 hover:bg-rose-500 text-white"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={onStart}
            className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white"
          >
            Start
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 flex-1 min-h-0 overflow-hidden">
        <div className="xl:col-span-1 border-r border-zinc-800 p-4 space-y-4 overflow-y-auto">
          <div>
            <div className="text-xs font-black uppercase tracking-widest text-zinc-400 mb-2">
              Mitglieder
            </div>
            <div className="space-y-2">
              {members.map((member) => {
                const persona = personaMap.get(member.personaId);
                const status = memberStatus[member.personaId];
                const memberState = status?.status ?? 'idle';
                const statusConfig: Record<string, { bg: string; text: string; label: string }> = {
                  idle: { bg: 'bg-emerald-600/20', text: 'text-emerald-300', label: 'Idle' },
                  busy: { bg: 'bg-amber-600/20', text: 'text-amber-300', label: 'Busy' },
                  interrupting: { bg: 'bg-orange-600/20', text: 'text-orange-300', label: 'Interrupting' },
                  interrupted: { bg: 'bg-zinc-600/20', text: 'text-zinc-300', label: 'Interrupted' },
                  error: { bg: 'bg-rose-600/20', text: 'text-rose-300', label: 'Error' },
                };
                const cfg = statusConfig[memberState] ?? statusConfig.idle;
                return (
                  <div key={member.personaId} className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm text-zinc-100 truncate">
                        {persona?.emoji || '🤖'} {persona?.name || member.personaId}
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full ${cfg.bg} ${cfg.text}`}
                        >
                          {cfg.label}
                        </span>
                        <button
                          onClick={() => onRemoveMember(member.personaId)}
                          className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-rose-700 text-zinc-200"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                    <div className="text-[11px] text-zinc-500 mt-1">
                      Rolle: {member.roleLabel}
                    </div>
                    <div className="text-[11px] text-zinc-500 mt-1">
                      active in {activeRoomCountsByPersona[member.personaId] || 0} rooms
                    </div>
                    {memberState !== 'idle' && status?.reason && (
                      <div className={`text-[11px] mt-1 ${cfg.text}`}>
                        {status.reason}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="pt-2 border-t border-zinc-800">
            <div className="text-xs font-black uppercase tracking-widest text-zinc-400 mb-2">
              Persona hinzufügen
            </div>
            <select
              value={selectedPersonaId}
              onChange={(event) => {
                const personaId = event.target.value;
                setSelectedPersonaId(personaId);
                const persona = personas.find((item) => item.id === personaId);
                if (persona && !roleLabel) {
                  setRoleLabel(persona.name);
                }
              }}
              className="w-full mb-2 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100"
            >
              <option value="">Persona wählen</option>
              {availablePersonas.map((persona) => (
                <option key={persona.id} value={persona.id}>
                  {persona.emoji} {persona.name}
                </option>
              ))}
            </select>
            <input
              value={roleLabel}
              onChange={(event) => setRoleLabel(event.target.value)}
              placeholder="Rolle (z.B. Mutter, Analyst)"
              className="w-full mb-2 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100"
            />
            <input
              value={modelOverride}
              onChange={(event) => setModelOverride(event.target.value)}
              placeholder="Model Override (optional)"
              className="w-full mb-2 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100"
            />
            <button
              onClick={() => {
                if (!selectedPersonaId || !roleLabel.trim()) {
                  return;
                }
                onAddMember(selectedPersonaId, roleLabel.trim(), modelOverride.trim());
                setSelectedPersonaId('');
                setRoleLabel('');
                setModelOverride('');
              }}
              className="w-full px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold uppercase tracking-wider"
            >
              Hinzufügen
            </button>
          </div>
        </div>

        <div className="xl:col-span-2 flex flex-col min-h-0 overflow-hidden">
          {/* Fixed header area — never scrolls */}
          <div className="flex-shrink-0 px-4 pt-4 pb-2 border-b border-zinc-800/50">
            {metrics && (
              <div className="mb-2 p-2 rounded-lg border border-zinc-800 bg-zinc-900 text-[11px] text-zinc-300 flex items-center gap-4">
                <span>Messages: {metrics.messageCount}</span>
                <span>Members: {metrics.memberCount}</span>
              </div>
            )}
            {interventions.length > 0 && (
              <div className="mb-2 p-2 rounded-lg border border-amber-800/50 bg-amber-950/20">
                <div className="text-[10px] font-black uppercase tracking-wider text-amber-300 mb-1">
                  Letzte Intervention
                </div>
                <div className="text-xs text-amber-100">{interventions[0]?.note}</div>
              </div>
            )}
            <div className="text-xs font-black uppercase tracking-widest text-zinc-400">
              Room Timeline
            </div>
          </div>

          {/* Scrollable messages area */}
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {loading && (
              <div className="text-zinc-500 text-sm">Lade Room-Daten...</div>
            )}
            {!loading && messages.length === 0 && (
              <div className="text-zinc-500 text-sm">Noch keine Nachrichten.</div>
            )}
            <div className="space-y-2">
              {messages.map((message) => {
                const persona = message.speakerPersonaId
                  ? personaMap.get(message.speakerPersonaId)
                  : null;
                const isUser = message.speakerType === 'user';
                const isSystem = message.speakerType === 'system';

                let speakerLabel: string;
                if (isUser) {
                  speakerLabel = '👤 Du';
                } else if (isSystem) {
                  speakerLabel = '⚙️ System';
                } else if (persona) {
                  speakerLabel = `${persona.emoji || '🤖'} ${persona.name}`;
                } else {
                  speakerLabel = message.speakerPersonaId
                    ? `🤖 ${message.speakerPersonaId.slice(0, 8)}…`
                    : '🤖 Persona';
                }

                return (
                  <div
                    key={`${message.roomId}-${message.seq}`}
                    className={`p-3 rounded-lg border ${
                      isUser
                        ? 'bg-indigo-950/30 border-indigo-800/40'
                        : isSystem
                          ? 'bg-amber-950/20 border-amber-800/30'
                          : 'bg-zinc-900 border-zinc-800'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-[11px] text-zinc-300 font-semibold">
                        {speakerLabel}
                      </span>
                      <span className="text-[10px] text-zinc-500" title={message.createdAt}>
                        {formatTimestamp(message.createdAt)}
                      </span>
                    </div>
                    <div className="text-sm text-zinc-100 whitespace-pre-wrap">{message.content}</div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* User Chat Input */}
          <div className="p-3 border-t border-zinc-800 bg-zinc-900/40">
            <div className="flex gap-2">
              <textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
                placeholder="Nachricht an den Room senden…"
                rows={1}
                className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 resize-none focus:outline-none focus:border-indigo-500 placeholder:text-zinc-600"
              />
              <button
                onClick={handleSendMessage}
                disabled={!chatInput.trim() || sending}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Senden
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
