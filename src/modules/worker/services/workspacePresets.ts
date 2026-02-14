import type { WorkspaceType } from '../../../../types';

export type WorkspacePresetMode = 'auto' | WorkspaceType;

export interface WorkspacePresetOption {
  value: WorkspacePresetMode;
  label: string;
  icon: string;
  description: string;
}

export const WORKSPACE_PRESET_OPTIONS: WorkspacePresetOption[] = [
  {
    value: 'auto',
    label: 'Auto (Empfohlen)',
    icon: '🤖',
    description: 'KI wählt den besten Arbeitsmodus automatisch',
  },
  {
    value: 'research',
    label: 'Research',
    icon: '📚',
    description: 'Web-Recherche, Analysen, PDF-Reports',
  },
  {
    value: 'webapp',
    label: 'Web App',
    icon: '🌐',
    description: 'Next.js, React, vollständige Web-Projekte',
  },
  {
    value: 'data',
    label: 'Daten',
    icon: '📊',
    description: 'CSV-Analyse, Charts, Datenverarbeitung',
  },
  {
    value: 'general',
    label: 'Allgemein',
    icon: '📝',
    description: 'Texte, Dokumente, sonstige Aufgaben',
  },
];

export function resolveWorkspaceTypeForTask(mode: WorkspacePresetMode): WorkspaceType | undefined {
  return mode === 'auto' ? undefined : mode;
}
