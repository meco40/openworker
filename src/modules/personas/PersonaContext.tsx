'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { PersonaSummary, PersonaWithFiles } from '@/server/personas/personaTypes';

// ─── Types ───────────────────────────────────────────────────
interface PersonaContextValue {
  /** All personas for the current user (summary only) */
  personas: PersonaSummary[];
  /** Currently active persona (full, with files) */
  activePersona: PersonaWithFiles | null;
  /** ID of the active persona (null = no persona / default mode) */
  activePersonaId: string | null;
  /** Switch to a different persona (null = deactivate) */
  setActivePersonaId: (id: string | null) => void;
  /** Reload the persona list from API */
  refreshPersonas: () => Promise<void>;
  /** Loading state */
  loading: boolean;
}

const PersonaContext = createContext<PersonaContextValue | null>(null);

// ─── Provider ────────────────────────────────────────────────
export function PersonaProvider({ children }: { children: React.ReactNode }) {
  const [personas, setPersonas] = useState<PersonaSummary[]>([]);
  const [activePersonaId, setActivePersonaIdState] = useState<string | null>(null);
  const [activePersona, setActivePersona] = useState<PersonaWithFiles | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch persona list
  const refreshPersonas = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/personas');
      if (res.ok) {
        const data = await res.json();
        setPersonas(data.personas ?? []);
      }
    } catch {
      // Silently fail — personas are optional
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on mount
  useEffect(() => {
    refreshPersonas();
  }, [refreshPersonas]);

  // Fetch full persona when activePersonaId changes
  useEffect(() => {
    if (!activePersonaId) {
      setActivePersona(null);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/personas/${activePersonaId}`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          setActivePersona(data.persona ?? null);
        } else if (!cancelled) {
          setActivePersona(null);
        }
      } catch {
        if (!cancelled) setActivePersona(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activePersonaId]);

  const setActivePersonaId = useCallback((id: string | null) => {
    setActivePersonaIdState(id);
    // Persist selection to localStorage for page reloads
    if (id) {
      localStorage.setItem('openclaw-active-persona', id);
    } else {
      localStorage.removeItem('openclaw-active-persona');
    }
  }, []);

  // Restore from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem('openclaw-active-persona');
    if (stored) {
      setActivePersonaIdState(stored);
    }
  }, []);

  const value = React.useMemo<PersonaContextValue>(
    () => ({
      personas,
      activePersona,
      activePersonaId,
      setActivePersonaId,
      refreshPersonas,
      loading,
    }),
    [personas, activePersona, activePersonaId, setActivePersonaId, refreshPersonas, loading],
  );

  return <PersonaContext.Provider value={value}>{children}</PersonaContext.Provider>;
}

// ─── Hook ────────────────────────────────────────────────────
export function usePersona(): PersonaContextValue {
  const ctx = useContext(PersonaContext);
  if (!ctx) {
    throw new Error('usePersona must be used within PersonaProvider');
  }
  return ctx;
}
