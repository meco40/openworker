import type { ConfigWarning } from '@/components/config/types';

export interface ConfigTabProps {
  parsedConfig: Record<string, unknown> | null;
  simpleModeDisabled: boolean;
  fieldErrorFor: (path: string) => string | null;
  updateConfigDraft: (mutate: (draft: Record<string, unknown>) => void) => void;
}

export interface OverviewTabProps {
  configSource: 'default' | 'file' | 'unknown';
  hasChanges: boolean;
  compatibilityWarnings: ConfigWarning[];
}
