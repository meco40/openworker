'use client';

import { useCallback, useState } from 'react';
import type { RoomGoalMode } from '../types';

interface CreateRoomModalProps {
  open: boolean;
  creating: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; description: string | null; goalMode: RoomGoalMode; routingProfileId: string }) => void;
}

type Step = 'name' | 'mode' | 'description';

const GOAL_MODE_INFO: Record<RoomGoalMode, { emoji: string; label: string; description: string }> = {
  planning: {
    emoji: '📋',
    label: 'Planning',
    description: 'Personas planen und diskutieren strukturiert. Ideal für Brainstorming und Strategieentwicklung.',
  },
  simulation: {
    emoji: '🎭',
    label: 'Simulation',
    description: 'Personas agieren in Rollen und simulieren Szenarien. Ideal für Rollenspiel und Szenarien-Tests.',
  },
  free: {
    emoji: '💬',
    label: 'Free',
    description: 'Offener Austausch ohne festes Schema. Ideal für freie Konversation und kreative Prozesse.',
  },
};

export function CreateRoomModal({ open, creating, onClose, onCreate }: CreateRoomModalProps) {
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [goalMode, setGoalMode] = useState<RoomGoalMode>('planning');
  const [description, setDescription] = useState('');

  const reset = useCallback(() => {
    setStep('name');
    setName('');
    setGoalMode('planning');
    setDescription('');
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const handleCreate = useCallback(() => {
    onCreate({
      name: name.trim(),
      description: description.trim() || null,
      goalMode,
      routingProfileId: 'p1',
    });
    reset();
  }, [name, description, goalMode, onCreate, reset]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="p-5 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">Neuen Room erstellen</h2>
            <div className="text-xs text-zinc-500 mt-0.5">
              Schritt {step === 'name' ? '1/3' : step === 'mode' ? '2/3' : '3/3'}
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Step Content */}
        <div className="p-5">
          {step === 'name' && (
            <div className="space-y-4">
              <div>
                <label className="text-xs font-black uppercase tracking-widest text-zinc-400 mb-2 block">
                  Room-Name
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && name.trim()) {
                      setStep('mode');
                    }
                  }}
                  placeholder="z.B. Office, Home, Strategie-Team"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500 placeholder:text-zinc-600"
                  autoFocus
                />
              </div>
            </div>
          )}

          {step === 'mode' && (
            <div className="space-y-3">
              <label className="text-xs font-black uppercase tracking-widest text-zinc-400 mb-2 block">
                Modus wählen
              </label>
              {(Object.entries(GOAL_MODE_INFO) as [RoomGoalMode, typeof GOAL_MODE_INFO.planning][]).map(
                ([mode, info]) => (
                  <button
                    key={mode}
                    onClick={() => setGoalMode(mode)}
                    className={`w-full text-left p-4 rounded-xl border transition-all ${
                      goalMode === mode
                        ? 'bg-indigo-600/20 border-indigo-500/40 text-white'
                        : 'bg-zinc-800/60 border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-white'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-xl">{info.emoji}</span>
                      <div>
                        <div className="text-sm font-bold">{info.label}</div>
                        <div className="text-[11px] text-zinc-400 mt-0.5">{info.description}</div>
                      </div>
                    </div>
                  </button>
                ),
              )}
            </div>
          )}

          {step === 'description' && (
            <div className="space-y-4">
              <div>
                <label className="text-xs font-black uppercase tracking-widest text-zinc-400 mb-2 block">
                  Aufgabe / Beschreibung
                </label>
                <p className="text-[11px] text-zinc-500 mb-3">
                  Beschreibe die Aufgabe oder das Ziel dieses Rooms. Die Personas erhalten diesen Kontext.
                </p>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="z.B. Analysiert die Q1-Ergebnisse und erstellt Handlungsempfehlungen…"
                  rows={4}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500 placeholder:text-zinc-600 resize-none"
                  autoFocus
                />
              </div>

              {/* Summary */}
              <div className="p-3 rounded-lg bg-zinc-800/60 border border-zinc-700">
                <div className="text-[10px] font-black uppercase tracking-wider text-zinc-400 mb-2">Zusammenfassung</div>
                <div className="text-sm text-zinc-100 font-semibold">{name}</div>
                <div className="text-xs text-zinc-400 mt-1">
                  {GOAL_MODE_INFO[goalMode].emoji} {GOAL_MODE_INFO[goalMode].label}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-zinc-800 flex items-center justify-between">
          <button
            onClick={step === 'name' ? handleClose : () => setStep(step === 'description' ? 'mode' : 'name')}
            className="px-4 py-2 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
          >
            {step === 'name' ? 'Abbrechen' : 'Zurück'}
          </button>

          {step === 'description' ? (
            <button
              onClick={handleCreate}
              disabled={creating || !name.trim()}
              className="px-6 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold uppercase tracking-wider disabled:opacity-40 transition-colors"
            >
              {creating ? 'Erstelle…' : 'Room erstellen'}
            </button>
          ) : (
            <button
              onClick={() => setStep(step === 'name' ? 'mode' : 'description')}
              disabled={step === 'name' && !name.trim()}
              className="px-6 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold uppercase tracking-wider disabled:opacity-40 transition-colors"
            >
              Weiter
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
