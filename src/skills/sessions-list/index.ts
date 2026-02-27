import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'sessions-list',
  name: 'Sessions List (Compat)',
  description: 'List sessions visible in OpenClaw integrated mode.',
  version: '1.0.0',
  category: 'Compatibility',
  functionName: 'sessions_list',
  tool: {
    name: 'sessions_list',
    description: 'List sessions with optional limit.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of sessions.' },
      },
    },
  },
};

const sessionsListSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('sessions_list', args),
};

export default sessionsListSkill;
