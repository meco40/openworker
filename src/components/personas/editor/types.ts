'use client';

import type {
  PersonaTabName,
  PersonaWithFiles,
  MemoryPersonaType,
} from '@/server/personas/personaTypes';

export interface PipelineModel {
  id: string;
  accountId: string;
  providerId: string;
  modelName: string;
  status: 'active' | 'rate-limited' | 'offline';
  priority: number;
}

export interface PersonaEditorPaneProps {
  selectedPersona: PersonaWithFiles;
  selectedId: string | null;
  editingMeta: boolean;
  setEditingMeta: (value: boolean) => void;
  metaName: string;
  setMetaName: (value: string) => void;
  metaEmoji: string;
  setMetaEmoji: (value: string) => void;
  metaVibe: string;
  setMetaVibe: (value: string) => void;
  saveMeta: () => void;
  saving: boolean;
  startEditMeta: () => void;
  activePersonaId: string | null;
  setActivePersonaId: (id: string | null) => void;
  duplicatePersona: () => void;
  creating: boolean;
  deletePersona: () => void;
  activeTab: PersonaTabName;
  setActiveTab: (tab: PersonaTabName) => void;
  dirty: boolean;
  setDirty: (value: boolean) => void;
  editorContent: string;
  setEditorContent: (value: string) => void;
  saveFile: () => void;
  // Gateway tab props
  pipelineModels: PipelineModel[];
  preferredModelId: string | null;
  onPreferredModelChange: (modelId: string | null) => void;
  savingPreferredModel: boolean;
  memoryPersonaType: MemoryPersonaType;
  onMemoryPersonaTypeChange: (type: MemoryPersonaType) => void;
  savingMemoryPersonaType: boolean;
  // Autonomous agent settings
  isAutonomous: boolean;
  maxToolCalls: number;
  onIsAutonomousChange: (value: boolean) => void;
  onMaxToolCallsChange: (value: number) => void;
  savingAutonomous: boolean;
}

export interface FormHeaderProps {
  selectedPersona: PersonaWithFiles;
  editingMeta: boolean;
  setEditingMeta: (value: boolean) => void;
  metaName: string;
  setMetaName: (value: string) => void;
  metaEmoji: string;
  setMetaEmoji: (value: string) => void;
  metaVibe: string;
  setMetaVibe: (value: string) => void;
  saveMeta: () => void;
  saving: boolean;
  startEditMeta: () => void;
  activePersonaId: string | null;
  setActivePersonaId: (id: string | null) => void;
  duplicatePersona: () => void;
  creating: boolean;
  deletePersona: () => void;
}

export interface BasicInfoSectionProps {
  editingMeta: boolean;
  setEditingMeta: (value: boolean) => void;
  metaName: string;
  setMetaName: (value: string) => void;
  metaEmoji: string;
  setMetaEmoji: (value: string) => void;
  metaVibe: string;
  setMetaVibe: (value: string) => void;
  saveMeta: () => void;
  saving: boolean;
}

export interface ModelConfigSectionProps {
  pipelineModels: PipelineModel[];
  preferredModelId: string | null;
  onPreferredModelChange: (modelId: string | null) => void;
  savingPreferredModel: boolean;
}

export interface MemoryTypeSectionProps {
  memoryPersonaType: MemoryPersonaType;
  onMemoryPersonaTypeChange: (type: MemoryPersonaType) => void;
  savingMemoryPersonaType: boolean;
}

export interface AutonomousConfigSectionProps {
  isAutonomous: boolean;
  maxToolCalls: number;
  onIsAutonomousChange: (value: boolean) => void;
  onMaxToolCallsChange: (value: number) => void;
  savingAutonomous: boolean;
}

export interface SystemPromptSectionProps {
  editorContent: string;
  setEditorContent: (value: string) => void;
  setDirty: (value: boolean) => void;
  activeTab: PersonaTabName;
}

export interface ActionButtonsProps {
  isGatewayTab: boolean;
  dirty: boolean;
  saving: boolean;
  savingPreferredModel: boolean;
  selectedId: string | null;
  editorContent: string;
  preferredModelId: string | null;
  onPreferredModelChange: (modelId: string | null) => void;
  saveFile: () => void;
}

export interface TabNavigationProps {
  activeTab: PersonaTabName;
  setActiveTab: (tab: PersonaTabName) => void;
  dirty: boolean;
}
