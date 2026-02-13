export type ConfigFieldRisk = 'safe' | 'restart-required' | 'sensitive';

export interface ConfigFieldMetadata {
  path: string;
  label: string;
  helper: string;
  example?: string;
  risk: ConfigFieldRisk;
}

export const CONFIG_FIELD_METADATA: ReadonlyArray<ConfigFieldMetadata> = Object.freeze([
  {
    path: 'gateway.port',
    label: 'Port',
    helper: 'Port des Gateways. Aendere nur, wenn ein Port-Konflikt besteht.',
    example: '8080',
    risk: 'restart-required',
  },
  {
    path: 'gateway.bind',
    label: 'Bind Preset',
    helper: 'Steuert, auf welchen Netzwerkschnittstellen das Gateway lauscht.',
    risk: 'restart-required',
  },
  {
    path: 'gateway.host',
    label: 'Host',
    helper: 'IP/Host fuer den Gateway-Bind. Fuer lokale Nutzung: 127.0.0.1.',
    example: '127.0.0.1',
    risk: 'restart-required',
  },
  {
    path: 'gateway.logLevel',
    label: 'Log Level',
    helper: 'Legt fest, wie detailliert Laufzeit-Logs ausgegeben werden.',
    risk: 'safe',
  },
  {
    path: 'ui.defaultView',
    label: 'Default View',
    helper: 'Startansicht beim Oeffnen der WebUI.',
    risk: 'safe',
  },
  {
    path: 'ui.density',
    label: 'Density',
    helper: 'Steuert den vertikalen Abstand in der UI.',
    risk: 'safe',
  },
  {
    path: 'ui.language',
    label: 'Language',
    helper: 'Sprachkennung im BCP-47 Format.',
    example: 'de-DE',
    risk: 'safe',
  },
  {
    path: 'ui.timeFormat',
    label: 'Time Format',
    helper: '12h oder 24h Anzeige fuer Zeiten.',
    risk: 'safe',
  },
  {
    path: 'ui.showAdvancedDebug',
    label: 'Show Advanced Debug',
    helper: 'Aktiviert erweiterte Debug-Informationen in der UI.',
    risk: 'safe',
  },
  {
    path: 'channels.telegram.token',
    label: 'Telegram Token',
    helper: 'Sensitiver Zugriffstoken. Wird in Antworten maskiert.',
    risk: 'sensitive',
  },
]);

const FIELD_METADATA_BY_PATH = new Map(CONFIG_FIELD_METADATA.map((entry) => [entry.path, entry]));

export function getFieldMetadata(path: string): ConfigFieldMetadata | undefined {
  return FIELD_METADATA_BY_PATH.get(path);
}

export function mapValidationMessageToFieldPath(message: string): string | null {
  const normalized = String(message || '').trim();
  if (!normalized) {
    return null;
  }

  for (const entry of CONFIG_FIELD_METADATA) {
    if (normalized.startsWith(entry.path) || normalized.includes(`${entry.path} `)) {
      return entry.path;
    }
  }

  const match = normalized.match(/^([a-zA-Z0-9_.]+)\s+/);
  if (match && FIELD_METADATA_BY_PATH.has(match[1])) {
    return match[1];
  }

  return null;
}
