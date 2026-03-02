/**
 * Configuration Management
 *
 * Handles user-configurable settings for Mission Control.
 * Settings are stored in localStorage for client-side access.
 *
 * NEVER commit hardcoded IPs, paths, or sensitive data!
 */

export interface MissionControlConfig {
  // Workspace settings
  workspaceBasePath: string; // e.g., ~/Documents/Shared
  projectsPath: string; // e.g., ${workspaceBasePath}/projects

  // Mission Control API URL (for orchestration)
  missionControlUrl: string; // Auto-detected or manually set

  // Runtime transport is integrated with this app (no standalone gateway required)

  // Project defaults
  defaultProjectName: string; // 'mission-control' or custom
}

const DEFAULT_CONFIG: MissionControlConfig = {
  workspaceBasePath: '~/Documents/Shared',
  projectsPath: '~/Documents/Shared/projects',
  missionControlUrl:
    typeof window !== 'undefined'
      ? window.location.origin
      : `http://localhost:${process.env.PORT || '3000'}`,
  defaultProjectName: 'mission-control',
};

const CONFIG_KEY = 'mission-control-config';

/**
 * Get current configuration
 * Returns defaults merged with user overrides
 */
export function getConfig(): MissionControlConfig {
  if (typeof window === 'undefined') {
    return DEFAULT_CONFIG;
  }

  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch (error) {
    console.error('Failed to load config:', error);
  }

  return DEFAULT_CONFIG;
}

/**
 * Update configuration
 * Validates and saves to localStorage
 */
export function updateConfig(updates: Partial<MissionControlConfig>): void {
  if (typeof window === 'undefined') {
    throw new Error('Cannot update config on server side');
  }

  const current = getConfig();
  const updated = { ...current, ...updates };

  // Validate paths
  if (updates.workspaceBasePath !== undefined) {
    if (!updates.workspaceBasePath.trim()) {
      throw new Error('Workspace base path cannot be empty');
    }
  }

  if (updates.missionControlUrl !== undefined) {
    try {
      new URL(updates.missionControlUrl);
    } catch {
      throw new Error('Invalid Mission Control URL');
    }
  }

  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(updated));
  } catch (error) {
    console.error('Failed to save config:', error);
    throw new Error('Failed to save configuration');
  }
}

/**
 * Reset configuration to defaults
 */
export function resetConfig(): void {
  if (typeof window === 'undefined') {
    throw new Error('Cannot reset config on server side');
  }

  localStorage.removeItem(CONFIG_KEY);
}

/**
 * Get Mission Control URL for API calls
 * Used by orchestration module and other server-side modules
 */
export function getMissionControlUrl(): string {
  // Server-side: use env var or auto-detect
  if (typeof window === 'undefined') {
    return process.env.MISSION_CONTROL_URL || `http://localhost:${process.env.PORT || '3000'}`;
  }

  // Client-side: use config
  return getConfig().missionControlUrl;
}

/**
 * Get projects path
 * Server-side only - returns configured path or default
 */
export function getProjectsPath(): string {
  if (typeof window !== 'undefined') {
    return getConfig().projectsPath;
  }

  // Server-side: check env var first, then default
  return process.env.PROJECTS_PATH || '~/Documents/Shared/projects';
}
