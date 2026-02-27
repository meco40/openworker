import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'sessions-history',
  name: 'Sessions History (Compat)',
  description: 'Read message history for a session.',
  version: '1.0.0',
  category: 'Compatibility',
  functionName: 'sessions_history',
  tool: {
    name: 'sessions_history',
    description: 'Read conversation history from a session id.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id/key.' },
      },
      required: ['sessionId'],
    },
  },
};

const sessionsHistorySkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('sessions_history', args),
};

export default sessionsHistorySkill;
