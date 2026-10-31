import type { PersonaSummary } from '@/shared/personaTypes';

/**
 * Picks the persona a view shows: the user's choice while it still exists, else the
 * active persona, else the first one. Derived during render, so a deleted or missing
 * persona never needs a corrective state update.
 */
export function resolveSelectedPersonaId(
  personas: PersonaSummary[],
  chosenId: string | null,
  activeId: string | null,
): string | null {
  if (personas.length === 0) return null;
  if (chosenId && personas.some((persona) => persona.id === chosenId)) return chosenId;
  if (activeId && personas.some((persona) => persona.id === activeId)) return activeId;
  return personas[0].id;
}
