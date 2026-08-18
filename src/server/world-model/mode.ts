export type WorldModelMode = 'off' | 'shadow' | 'required' | 'canonical';

export interface WorldModelModeConfig {
  mode: WorldModelMode;
  /**
   * Compatible legacy switches. These remain for migration and are superseded
   * by the single mode value.
   */
  ingestionBridgeEnabled: boolean;
  mem0PreferencesOnly: boolean;
}

export const WORLD_MODEL_MODES: readonly WorldModelMode[] = [
  'off',
  'shadow',
  'required',
  'canonical',
];

const MODE_ALIASES: Record<string, WorldModelMode> = {
  off: 'off',
  disabled: 'off',
  shadow: 'shadow',
  required: 'required',
  canonical: 'canonical',
};

export const WORLD_MODEL_DEFAULT_MODE: WorldModelMode = 'off';

export function parseWorldModelMode(value: string | undefined): WorldModelMode {
  if (!value) return WORLD_MODEL_DEFAULT_MODE;
  const normalized = String(value).trim().toLowerCase();
  if (normalized in MODE_ALIASES) return MODE_ALIASES[normalized];
  return WORLD_MODEL_DEFAULT_MODE;
}

export function isWorldModelActive(mode: WorldModelMode): boolean {
  return mode === 'shadow' || mode === 'required' || mode === 'canonical';
}

export function isWorldModelRequired(mode: WorldModelMode): boolean {
  return mode === 'required' || mode === 'canonical';
}

export function isWorldModelCanonical(mode: WorldModelMode): boolean {
  return mode === 'canonical';
}

export function modeFromLegacyFlags(input: {
  enabled: boolean;
  ingestionBridgeEnabled: boolean;
  mem0PreferencesOnly: boolean;
}): WorldModelMode {
  if (!input.enabled && !input.ingestionBridgeEnabled) return 'off';
  if (input.mem0PreferencesOnly) return 'canonical';
  if (input.ingestionBridgeEnabled) return 'shadow';
  return 'off';
}
