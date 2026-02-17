/**
 * Project lifecycle tracking with disambiguation and versioning.
 *
 * Pure functions for detecting project status signals from text,
 * and disambiguating mentioned project names against existing projects.
 */

export type ProjectStatus =
  | 'idea'
  | 'design'
  | 'in_progress'
  | 'deployed'
  | 'maintenance'
  | 'paused'
  | 'abandoned';

export interface ProjectState {
  entityId: string;
  entityName: string;
  status: ProjectStatus;
  lastWorkedOn: string;
}

export interface DisambiguationResult {
  action: 'use_existing' | 'create_version';
  existingId?: string;
  version?: string;
}

const STATUS_PATTERNS: Array<{ pattern: RegExp; status: ProjectStatus }> = [
  {
    pattern: /\b(?:live|deployed|released|veroeffentlicht|veröffentlicht|auf vercel|auf prod)\b/i,
    status: 'deployed',
  },
  { pattern: /\b(?:pausiert|on hold|pause|ruht)\b/i, status: 'paused' },
  {
    pattern: /\b(?:aufgegeben|eingestellt|abgebrochen|cancelled|abandoned)\b/i,
    status: 'abandoned',
  },
  { pattern: /\b(?:wartung|maintenance|bugfix)\b/i, status: 'maintenance' },
  { pattern: /\b(?:idee|idea|konzept|concept)\b/i, status: 'idea' },
  { pattern: /\b(?:design|entwurf|planung)\b/i, status: 'design' },
  {
    pattern: /\b(?:arbeite|coding|implementier|develop|baue|programmier)\b/i,
    status: 'in_progress',
  },
];

/** Version suffix patterns: "Notes3", "Dashboard v2", "App V3" */
const VERSION_SUFFIX = /^(.+?)(\d+)$/;
const V_PREFIX_SUFFIX = /^(.+?)\s+v(\d+)$/i;

/** Restart signals: "neu bauen", "komplett neu", "von vorne" */
const RESTART_SIGNAL = /\b(?:neu bauen|komplett neu|von vorne|restart|rewrite|v2)\b/i;

/**
 * Detect a project status signal from free text.
 * Returns the detected status or null if no clear signal found.
 */
export function detectProjectStatusSignal(text: string): ProjectStatus | null {
  for (const { pattern, status } of STATUS_PATTERNS) {
    if (pattern.test(text)) {
      return status;
    }
  }
  return null;
}

/**
 * Disambiguate a mentioned project name against a list of existing projects.
 *
 * - Exact name match (case-insensitive) on an active project → use_existing
 * - Version suffix detected (e.g., "Notes3" vs existing "Notes") → create_version
 * - Restart signal in context ("komplett neu bauen") → create_version
 * - No match → create_version with no existingId
 */
export function disambiguateProject(
  mentionedName: string,
  existingProjects: ProjectState[],
  messageContext: string,
): DisambiguationResult {
  const lower = mentionedName.toLowerCase();

  // 1. Exact match (case-insensitive)
  const exactMatch = existingProjects.find((p) => p.entityName.toLowerCase() === lower);
  if (exactMatch) {
    // Check for restart signal in context
    if (RESTART_SIGNAL.test(messageContext)) {
      return {
        action: 'create_version',
        existingId: exactMatch.entityId,
      };
    }
    return { action: 'use_existing', existingId: exactMatch.entityId };
  }

  // 2. "v2" prefix pattern: "Dashboard v2" → base "Dashboard"
  const vMatch = V_PREFIX_SUFFIX.exec(mentionedName);
  if (vMatch) {
    const baseName = vMatch[1].trim().toLowerCase();
    const version = `v${vMatch[2]}`;
    const baseProject = existingProjects.find((p) => p.entityName.toLowerCase() === baseName);
    if (baseProject) {
      return { action: 'create_version', existingId: baseProject.entityId, version };
    }
  }

  // 3. Numeric suffix pattern: "Notes3" → base "Notes", version "3"
  const numMatch = VERSION_SUFFIX.exec(mentionedName);
  if (numMatch) {
    const baseName = numMatch[1].trim().toLowerCase();
    const version = numMatch[2];
    const baseProject = existingProjects.find((p) => p.entityName.toLowerCase() === baseName);
    if (baseProject) {
      return { action: 'create_version', existingId: baseProject.entityId, version };
    }
  }

  // 4. No match found → create new (no existingId)
  return { action: 'create_version' };
}
