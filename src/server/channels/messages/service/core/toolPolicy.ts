export const ROLEPLAY_TOOLS_DISABLED_MESSAGE =
  'Tools sind fuer diese Roleplay-Persona deaktiviert.';

export function areToolsDisabledForPersona(
  persona: { memoryPersonaType?: string | null } | null | undefined,
): boolean {
  return (
    String(persona?.memoryPersonaType || '')
      .trim()
      .toLowerCase() === 'roleplay'
  );
}
