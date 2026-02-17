'use client';

import { useEffect, useState } from 'react';
import type { PersonaTemplate } from '../../../lib/persona-templates';

interface UsePersonaTemplatesReturn {
  templates: PersonaTemplate[];
  showTemplates: boolean;
  setShowTemplates: (show: boolean) => void;
}

export function usePersonaTemplates(): UsePersonaTemplatesReturn {
  const [templates, setTemplates] = useState<PersonaTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/personas/templates');
        if (res.ok) {
          const data = await res.json();
          setTemplates(data.templates ?? []);
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  return {
    templates,
    showTemplates,
    setShowTemplates,
  };
}
