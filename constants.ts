import { Team, CommandPermission, AIProvider } from './types';

export const INITIAL_TEAMS: Team[] = [
  {
    id: 'team-personal',
    name: 'Personal Workspaces',
    role: 'Admin',
    memberCount: 1,
    workspaces: [],
    tier: 'Starter',
  },
  {
    id: 'team-internal',
    name: 'OpenClaw Internal',
    role: 'Admin',
    memberCount: 4,
    workspaces: [],
    tier: 'Enterprise',
  },
];

// INITIAL_SKILLS removed — skills are now loaded from SQLite via GET /api/skills

export const SECURITY_RULES: CommandPermission[] = [
  {
    id: 'c1',
    command: 'ls',
    description: 'List directory contents',
    category: 'Files',
    risk: 'Low',
    enabled: true,
  },
  {
    id: 'c2',
    command: 'pwd',
    description: 'Print working directory',
    category: 'Files',
    risk: 'Low',
    enabled: true,
  },
  {
    id: 'c3',
    command: 'mkdir',
    description: 'Create new directories',
    category: 'Files',
    risk: 'Medium',
    enabled: true,
  },
  {
    id: 'c4',
    command: 'npm install',
    description: 'Install package dependencies',
    category: 'DevOps',
    risk: 'Medium',
    enabled: true,
  },
  {
    id: 'c7',
    command: 'rm -rf',
    description: 'Recursive deletion (Danger)',
    category: 'System',
    risk: 'High',
    enabled: false,
  },
  {
    id: 'c8',
    command: 'curl',
    description: 'Transfer data from/to a server',
    category: 'Network',
    risk: 'Medium',
    enabled: true,
  },
];

/** @deprecated Use PROVIDER_CATALOG from src/server/model-hub/providerCatalog instead */
export const REAL_MODELS = [
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
  'gemini-2.5-flash-lite-latest',
  'gemini-2.5-flash-latest',
  'gemini-2.5-flash-image',
  'gemini-3-pro-image-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025',
];

/** @deprecated Use PROVIDER_CATALOG from src/server/model-hub/providerCatalog instead */
export const GEMINI_PROVIDER: AIProvider = {
  id: 'gemini',
  name: 'Google Gemini',
  authType: 'api_key',
  icon: '✨',
  availableModels: REAL_MODELS,
};
