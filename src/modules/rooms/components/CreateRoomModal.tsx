'use client';

import { useCallback, useState } from 'react';
import type { RoomGoalMode } from '@/modules/rooms/types';

interface CreateRoomModalProps {
  open: boolean;
  creating: boolean;
  onClose: () => void;
  onCreate: (input: {
    name: string;
    description: string | null;
    goalMode: RoomGoalMode;
    routingProfileId: string;
  }) => void;
}

type Step = 'name' | 'mode' | 'description';

const GOAL_MODE_INFO: Record<RoomGoalMode, { emoji: string; label: string; description: string }> =
  {
    planning: {
      emoji: '📋',
      label: 'Planning',
      description:
        'Personas planen und diskutieren strukturiert. Ideal für Brainstorming und Strategieentwicklung.',
    },
    simulation: {
      emoji: '🎭',
      label: 'Simulation',
      description:
        'Personas agieren in Rollen und simulieren Szenarien. Ideal für Rollenspiel und Szenarien-Tests.',
    },
    free: {
      emoji: '💬',
      label: 'Free',
      description:
        'Offener Austausch ohne festes Schema. Ideal für freie Konversation und kreative Prozesse.',
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
      <div className="mx-4 w-full max-w-lg overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 p-5">
          <div>
            <h2 className="text-lg font-bold text-white">Neuen Room erstellen</h2>
            <div className="mt-0.5 text-xs text-zinc-500">
              Schritt {step === 'name' ? '1/3' : step === 'mode' ? '2/3' : '3/3'}
            </div>
          </div>
          <button
            onClick={handleClose}
            className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Step Content */}
        <div className="p-5">
          {step === 'name' && (
            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-xs font-black tracking-widest text-zinc-400 uppercase">
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
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                  autoFocus
                />
              </div>
            </div>
          )}

          {step === 'mode' && (
            <div className="space-y-3">
              <label className="mb-2 block text-xs font-black tracking-widest text-zinc-400 uppercase">
                Modus wählen
              </label>
              {(
                Object.entries(GOAL_MODE_INFO) as [RoomGoalMode, typeof GOAL_MODE_INFO.planning][]
              ).map(([mode, info]) => (
                <button
                  key={mode}
                  onClick={() => setGoalMode(mode)}
                  className={`w-full rounded-xl border p-4 text-left transition-all ${
                    goalMode === mode
                      ? 'border-indigo-500/40 bg-indigo-600/20 text-white'
                      : 'border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-800 hover:text-white'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xl">{info.emoji}</span>
                    <div>
                      <div className="text-sm font-bold">{info.label}</div>
                      <div className="mt-0.5 text-[11px] text-zinc-400">{info.description}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {step === 'description' && (
            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-xs font-black tracking-widest text-zinc-400 uppercase">
                  Aufgabe / Beschreibung
                </label>
                <p className="mb-3 text-[11px] text-zinc-500">
                  Beschreibe die Aufgabe oder das Ziel dieses Rooms. Die Personas erhalten diesen
                  Kontext.
                </p>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="z.B. Analysiert die Q1-Ergebnisse und erstellt Handlungsempfehlungen…"
                  rows={4}
                  className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                  autoFocus
                />
              </div>

              {/* Summary */}
              <div className="rounded-lg border border-zinc-700 bg-zinc-800/60 p-3">
                <div className="mb-2 text-[10px] font-black tracking-wider text-zinc-400 uppercase">
                  Zusammenfassung
                </div>
                <div className="text-sm font-semibold text-zinc-100">{name}</div>
                <div className="mt-1 text-xs text-zinc-400">
                  {GOAL_MODE_INFO[goalMode].emoji} {GOAL_MODE_INFO[goalMode].label}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-800 p-5">
          <button
            onClick={
              step === 'name'
                ? handleClose
                : () => setStep(step === 'description' ? 'mode' : 'name')
            }
            className="rounded-lg bg-zinc-800 px-4 py-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-700"
          >
            {step === 'name' ? 'Abbrechen' : 'Zurück'}
          </button>

          {step === 'description' ? (
            <button
              onClick={handleCreate}
              disabled={creating || !name.trim()}
              className="rounded-lg bg-emerald-600 px-6 py-2 text-xs font-bold tracking-wider text-white uppercase transition-colors hover:bg-emerald-500 disabled:opacity-40"
            >
              {creating ? 'Erstelle…' : 'Room erstellen'}
            </button>
          ) : (
            <button
              onClick={() => setStep(step === 'name' ? 'mode' : 'description')}
              disabled={step === 'name' && !name.trim()}
              className="rounded-lg bg-indigo-600 px-6 py-2 text-xs font-bold tracking-wider text-white uppercase transition-colors hover:bg-indigo-500 disabled:opacity-40"
            >
              Weiter
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
