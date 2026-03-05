'use client';

import React from 'react';
import { MEMORY_PERSONA_TYPES, MEMORY_PERSONA_TYPE_LABELS } from '@/server/personas/personaTypes';
import type { MemoryTypeSectionProps } from '../types';

export function MemoryTypeSection({
  memoryPersonaType,
  onMemoryPersonaTypeChange,
  savingMemoryPersonaType,
  readOnly = false,
  readOnlyMessage,
}: MemoryTypeSectionProps) {
  return (
    <div className="space-y-2 border-t border-zinc-800 pt-6">
      <h4 className="text-lg font-bold text-white">Memory Persona-Typ</h4>
      <p className="text-sm text-zinc-400">
        Bestimmt, wie das Gedächtnissystem Wissen extrahiert und gewichtet. Roleplay priorisiert
        Emotionen und Beziehungen, Builder fokussiert auf Projekte und Tech-Entscheidungen,
        Assistent auf Aufgaben und Termine.
      </p>
      <div className="space-y-2">
        <label htmlFor="persona-memory-type" className="text-sm font-medium text-zinc-300">
          Persona-Typ
        </label>
        <select
          id="persona-memory-type"
          value={memoryPersonaType}
          onChange={(e) => onMemoryPersonaTypeChange(e.target.value as typeof memoryPersonaType)}
          disabled={readOnly || savingMemoryPersonaType}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {MEMORY_PERSONA_TYPES.map((type) => (
            <option key={type} value={type}>
              {MEMORY_PERSONA_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
        {readOnlyMessage && <p className="text-xs text-amber-300/80">{readOnlyMessage}</p>}
      </div>
    </div>
  );
}
