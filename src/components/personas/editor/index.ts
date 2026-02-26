'use client';

// Re-export the main component for backward compatibility
export { PersonaEditorPane } from './PersonaEditorPane';

// Export types for consumers who need them
export type {
  PersonaEditorPaneProps,
  PipelineModel,
  FormHeaderProps,
  BasicInfoSectionProps,
  ModelConfigSectionProps,
  MemoryTypeSectionProps,
  AutonomousConfigSectionProps,
  SystemPromptSectionProps,
  ActionButtonsProps,
  TabNavigationProps,
} from './types';

// Export hooks for advanced use cases
export { usePersonaForm, usePersonaSave, useValidation } from './hooks';

// Export constants
export { TOOL_CALLS_CONFIG } from './constants';
