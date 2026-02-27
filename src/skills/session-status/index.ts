import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'session-status',
  name: 'Session Status (Compat)',
  description: 'Resolve status for a session, optionally with history.',
  version: '1.0.0',
  category: 'Compatibility',
  functionName: 'session_status',
  tool: {
    name: 'session_status',
    description: 'Read session status by session id/key.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id to inspect.' },
        includeHistory: { type: 'boolean', description: 'Include message history.' },
      },
    },
  },
};

const sessionStatusSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('session_status', args),
};

export default sessionStatusSkill;
