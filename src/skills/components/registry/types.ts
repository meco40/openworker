import type { Skill } from '@/shared/domain/types';
import type { ClawHubInstalledSkill, ClawHubSearchItem } from '@/skills/clawhub-client';
import type { SkillRuntimeConfigStatus } from '@/skills/runtime-config-client';

export type InstallTab = 'github' | 'npm' | 'manifest' | 'clawhub';
export type RegistryTab = 'skills' | 'tool-configuration';

export interface SkillsRegistryProps {
  skills: Skill[];
  setSkills: React.Dispatch<React.SetStateAction<Skill[]>>;
}

export interface UseClawHubReturn {
  query: string;
  setQuery: (value: string) => void;
  searchResults: ClawHubSearchItem[];
  searchWarnings: string[];
  installed: ClawHubInstalledSkill[];
  loading: boolean;
  error: string;
  busyRef: React.RefObject<boolean>;
  beginAction: () => boolean;
  endAction: () => void;
  refreshInstalled: () => Promise<void>;
  handleSearch: () => Promise<void>;
  handleSearchReset: () => void;
  handleInstall: (slug: string) => Promise<void>;
  handleUpdate: (slug?: string) => Promise<void>;
  handleUninstall: (slug: string) => Promise<void>;
  handleToggleEnabled: (slug: string, enabled: boolean) => Promise<void>;
}

export interface UseRuntimeConfigsReturn {
  configs: SkillRuntimeConfigStatus[];
  drafts: Record<string, string>;
  loading: boolean;
  savingId: string | null;
  error: string;
  loadConfigs: () => Promise<void>;
  handleDraft: (id: string, value: string) => void;
  handleSave: (id: string) => Promise<void>;
  handleClear: (id: string) => Promise<void>;
  getMissingRequired: (skillId: string) => SkillRuntimeConfigStatus[];
}

export interface UseSkillActionsReturn {
  actionError: string;
  setActionError: (error: string) => void;
  handleToggleInstall: (id: string) => Promise<void>;
  handleRemove: (id: string) => Promise<void>;
  handleSyncRefresh: (
    beginClawHubAction: () => boolean,
    endClawHubAction: () => void,
    loadRuntimeConfigs: () => Promise<void>,
  ) => Promise<void>;
  handleInstall: (params: {
    tab: InstallTab;
    value: string;
    beginClawHubAction: () => boolean;
    endClawHubAction: () => void;
    refreshClawHubInstalled: () => Promise<void>;
    setShowModal: (show: boolean) => void;
    setInstallValue: (value: string) => void;
  }) => Promise<void>;
}

export const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  'built-in': { label: 'Built-in', color: 'text-zinc-500 bg-zinc-800 border-zinc-700' },
  github: { label: 'GitHub', color: 'text-purple-400 bg-purple-500/10 border-purple-500/20' },
  npm: { label: 'npm', color: 'text-red-400 bg-red-500/10 border-red-500/20' },
  manual: { label: 'Manual', color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
};

export function normalizeInstalledSkills(skills: ClawHubInstalledSkill[]): ClawHubInstalledSkill[] {
  return skills.map((skill) => ({
    ...skill,
    enabled: Boolean(skill.enabled),
  }));
}
