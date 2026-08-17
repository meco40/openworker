'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PersonaTemplate } from '@/lib/persona-templates';

interface UsePersonaTemplatesReturn {
  templates: PersonaTemplate[];
  showTemplates: boolean;
  setShowTemplates: (show: boolean) => void;
}

export function usePersonaTemplates(): UsePersonaTemplatesReturn {
  const [templates, setTemplates] = useState<PersonaTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const loadedRef = useRef(false);
  const loadingRef = useRef<Promise<void> | null>(null);

  const loadTemplates = useCallback(async () => {
    if (loadedRef.current) return;
    if (loadingRef.current) return loadingRef.current;

    const loadPromise = (async () => {
      try {
        const res = await fetch('/api/personas/templates');
        if (res.ok) {
          const data = await res.json();
          setTemplates(data.templates ?? []);
          loadedRef.current = true;
        }
      } catch {
        /* ignore */
      } finally {
        loadingRef.current = null;
      }
    })();

    loadingRef.current = loadPromise;
    return loadPromise;
  }, []);

  useEffect(() => {
    if (!showTemplates) return;
    void loadTemplates();
  }, [loadTemplates, showTemplates]);

  return {
    templates,
    showTemplates,
    setShowTemplates,
  };
}
