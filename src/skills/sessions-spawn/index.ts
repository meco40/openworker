import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'sessions-spawn',
  name: 'Sessions Spawn (Compat)',
  description: 'Create a new session and optionally dispatch a first task.',
  version: '1.0.0',
  category: 'Compatibility',
  functionName: 'sessions_spawn',
  tool: {
    name: 'sessions_spawn',
    description: 'Spawn/create a session with optional initial task.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Human-readable session label.' },
        task: { type: 'string', description: 'Initial task/content to send.' },
        channel: { type: 'string', description: 'Target channel (optional).' },
      },
    },
  },
};

const sessionsSpawnSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('sessions_spawn', args),
};

export default sessionsSpawnSkill;
