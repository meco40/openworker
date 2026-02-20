/**
 * Persona-type-specific conversation summary prompts.
 *
 * Each persona type gets a different summarization style:
 * - roleplay: narrative with emotional focus
 * - builder: structured status report
 * - assistant: task-oriented list
 * - general: concise overview
 */

import type { PersonaType } from '@/server/knowledge/personaTypeDetector';

export const SUMMARY_PROMPTS: Record<PersonaType, string> = {
  roleplay: `Fasse das Gespraech als NARRATIVE zusammen.
Fokus auf: Emotionale Entwicklung, Beziehungs-Dynamik, wichtige geteilte Momente.
Schreibe in dritter Person. Beispiel:
"Nata und der User sprachen ueber ihre Kindheit. Nata war emotional bewegt und teilte
eine persoenliche Geschichte ueber ihren Bruder Max. Der Ton war vertraut und warmherzig."
Nenne: Emotionaler Verlauf, Gefuehle, Beziehungs-Updates, geteilte Erlebnisse.`,

  builder: `Fasse das Gespraech als STATUS-REPORT zusammen.
Fokus auf: Was wurde gebaut/geaendert, welche Tech-Entscheidungen, offene Issues.
Format:
- Projekt: [Name]
- Erledigt: [Was wurde fertig]
- Offen: [Was noch fehlt]
- Tech-Stack: [Genutzte Technologien]
- Entscheidungen: [Warum wir X statt Y genommen haben]`,

  assistant: `Fasse das Gespraech als AUFGABEN-STATUS zusammen.
Fokus auf: Neue Tasks, erledigte Tasks, verschobene Deadlines, geaenderte Preferences.
Format:
- Neue Aufgaben: [Task + Deadline falls vorhanden]
- Erledigt: [Was abgehakt wurde]
- Geaendert: [Umplanungen, neue Infos]
- Dauerhafte Preferences: [Neue Vorlieben/Abneigungen]`,

  general: `Fasse das Gespraech in 2-4 Saetzen zusammen.
Nenne die Hauptthemen und wichtigsten Ergebnisse.
Schreibe in dritter Person.`,
};

/**
 * Get the summary prompt for a given persona type.
 */
export function getSummaryPrompt(personaType: PersonaType): string {
  return SUMMARY_PROMPTS[personaType];
}
