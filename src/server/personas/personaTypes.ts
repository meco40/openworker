// ─── Persona Types ───────────────────────────────────────────

/** Maximum combined character length for SOUL.md + AGENTS.md + USER.md system instruction */
export const MAX_PERSONA_INSTRUCTION_CHARS = 4000;

/** Valid persona file names (analogous to OpenClaw workspace bootstrap files) */
export type PersonaFileName =
  | 'SOUL.md'
  | 'IDENTITY.md'
  | 'AGENTS.md'
  | 'USER.md'
  | 'TOOLS.md'
  | 'HEARTBEAT.md';

export const PERSONA_FILE_NAMES: PersonaFileName[] = [
  'SOUL.md',
  'IDENTITY.md',
  'AGENTS.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
];

/** Tab names for persona editor (includes file tabs and special tabs) */
export type PersonaTabName = PersonaFileName | 'GATEWAY';

export const PERSONA_TAB_NAMES: PersonaTabName[] = [
  'SOUL.md',
  'IDENTITY.md',
  'AGENTS.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'GATEWAY',
];

/** Files that compose the system instruction sent to the AI */
export const PERSONA_INSTRUCTION_FILES: PersonaFileName[] = ['SOUL.md', 'AGENTS.md', 'USER.md'];

export interface PersonaProfile {
  id: string;
  name: string;
  emoji: string;
  vibe: string;
  preferredModelId: string | null;
  modelHubProfileId: string | null;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaWithFiles extends PersonaProfile {
  files: Partial<Record<PersonaFileName, string>>;
}

export interface PersonaSummary {
  id: string;
  name: string;
  emoji: string;
  vibe: string;
  preferredModelId: string | null;
  modelHubProfileId: string | null;
  updatedAt: string;
}

export interface CreatePersonaInput {
  name: string;
  emoji: string;
  vibe: string;
  userId: string;
  preferredModelId?: string | null;
  modelHubProfileId?: string | null;
  files?: Partial<Record<PersonaFileName, string>>;
}
