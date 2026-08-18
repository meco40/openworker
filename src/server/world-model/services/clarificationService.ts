export interface ClarificationCandidate {
  id: string;
  label: string;
  summary?: string;
}

export interface ClarificationPrompt {
  prompt: string;
  candidates: ClarificationCandidate[];
}

/**
 * Erzeugt eine Rückfrage, wenn mehrere offene Fragen/Mehrdeutigkeiten zur
 * gleichen Nutzerantwort passen. Kein Weltzustand wird geändert, bis der Nutzer
 * geantwortet hat.
 */
export function buildClarificationPrompt(
  ambiguousTargets: Array<{ id: string; label: string; summary?: string }>,
  subjectText?: string,
): ClarificationPrompt | null {
  if (ambiguousTargets.length < 2) return null;
  const prompt = subjectText
    ? `Deine Antwort könnte sich auf mehrere Dinge beziehen. Meinst du:`
    : 'Es gibt mehrere passende offene Punkte. Worauf beziehst du dich?';
  return {
    prompt,
    candidates: ambiguousTargets.map((target) => ({
      id: target.id,
      label: target.label,
      summary: target.summary,
    })),
  };
}

export function isAmbiguous(build: ClarificationPrompt | null): boolean {
  return build !== null;
}

/**
 * Auswahl einer eindeutigen Antwort-Candidate aus einer ClarificationPrompt.
 * Keine Heuristik nötig: die UI/der Nutzer wählt eine ID; hier wird nur validiert
 * und das Ergebnis zur Korrelation geliefert.
 */
export function resolveClarificationChoice(
  prompt: ClarificationPrompt,
  selectedId: string,
): ClarificationCandidate {
  const found = prompt.candidates.find((candidate) => candidate.id === selectedId);
  if (!found) {
    throw new Error(
      `[world-model] clarification choice '${selectedId}' is not among the offered candidates`,
    );
  }
  return found;
}
