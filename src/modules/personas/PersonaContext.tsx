'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type {
  PersonaFileName,
  PersonaSummary,
  PersonaWithFiles,
} from '@/server/personas/personaTypes';

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
  /** Load a persona with shared cache + in-flight request dedupe */
  loadPersonaById: (id: string, options?: { force?: boolean }) => Promise<PersonaWithFiles | null>;
  /** Patch a single persona file in the shared details cache */
  patchPersonaFile: (id: string, filename: PersonaFileName, content: string) => void;
  /** Loading state */
  loading: boolean;
  /** Enables/disables network-backed persona data loading */
  setDataEnabled: (enabled: boolean) => void;
}

const PersonaContext = createContext<PersonaContextValue | null>(null);

// ─── Provider ────────────────────────────────────────────────
export function PersonaProvider({ children }: { children: React.ReactNode }) {
  const [personas, setPersonas] = useState<PersonaSummary[]>([]);
  const [activePersonaId, setActivePersonaIdState] = useState<string | null>(null);
  const [activePersona, setActivePersona] = useState<PersonaWithFiles | null>(null);
  const [loading, setLoading] = useState(false);
  const [dataEnabled, setDataEnabled] = useState(false);
  const personaDetailsCacheRef = useRef<Map<string, PersonaWithFiles>>(new Map());
  const personaLoadPromisesRef = useRef<Map<string, Promise<PersonaWithFiles | null>>>(new Map());

  const patchPersonaFile = useCallback((id: string, filename: PersonaFileName, content: string) => {
    const personaId = String(id || '').trim();
    if (!personaId) {
      return;
    }
    const cached = personaDetailsCacheRef.current.get(personaId);
    if (!cached) {
      return;
    }
    personaDetailsCacheRef.current.set(personaId, {
      ...cached,
      files: {
        ...cached.files,
        [filename]: content,
      },
    });
    setActivePersona((current) => {
      if (!current || current.id !== personaId) {
        return current;
      }
      return {
        ...current,
        files: {
          ...current.files,
          [filename]: content,
        },
      };
    });
  }, []);

  const loadPersonaById = useCallback(
    async (id: string, options?: { force?: boolean }): Promise<PersonaWithFiles | null> => {
      const personaId = String(id || '').trim();
      if (!personaId) {
        return null;
      }

      const force = options?.force === true;
      if (!force) {
        const cached = personaDetailsCacheRef.current.get(personaId);
        if (cached) {
          return cached;
        }
      }

      const inflight = personaLoadPromisesRef.current.get(personaId);
      if (inflight) {
        return inflight;
      }

      const request = (async () => {
        try {
          const res = await fetch(`/api/personas/${personaId}`, { cache: 'no-store' });
          if (!res.ok) {
            personaDetailsCacheRef.current.delete(personaId);
            return null;
          }

          const data = (await res.json()) as { persona?: PersonaWithFiles | null };
          const persona = data.persona ?? null;
          if (!persona) {
            personaDetailsCacheRef.current.delete(personaId);
            return null;
          }
          personaDetailsCacheRef.current.set(personaId, persona);
          return persona;
        } catch {
          return null;
        } finally {
          personaLoadPromisesRef.current.delete(personaId);
        }
      })();

      personaLoadPromisesRef.current.set(personaId, request);
      return request;
    },
    [],
  );

  // Fetch persona list
  const refreshPersonas = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/personas');
      if (res.ok) {
        const data = await res.json();
        setPersonas(data.personas ?? []);
        personaDetailsCacheRef.current.clear();
      }
    } catch {
      // Silently fail — personas are optional
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on mount
  useEffect(() => {
    if (!dataEnabled) {
      return;
    }
    void refreshPersonas();
  }, [refreshPersonas, dataEnabled]);

  // Fetch full persona when activePersonaId changes
  useEffect(() => {
    if (!dataEnabled) {
      return;
    }

    if (!activePersonaId) {
      setActivePersona(null);
      return;
    }

    let cancelled = false;
    (async () => {
      const persona = await loadPersonaById(activePersonaId, { force: true });
      if (!cancelled) {
        setActivePersona(persona);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activePersonaId, dataEnabled, loadPersonaById]);

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
      loadPersonaById,
      patchPersonaFile,
      loading,
      setDataEnabled,
    }),
    [
      personas,
      activePersona,
      activePersonaId,
      setActivePersonaId,
      refreshPersonas,
      loadPersonaById,
      patchPersonaFile,
      loading,
      setDataEnabled,
    ],
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
