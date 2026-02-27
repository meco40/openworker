import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'sessions-send',
  name: 'Sessions Send (Compat)',
  description: 'Send a message to a target session.',
  version: '1.0.0',
  category: 'Compatibility',
  functionName: 'sessions_send',
  tool: {
    name: 'sessions_send',
    description: 'Send content to a session id/key.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target session id.' },
        content: { type: 'string', description: 'Message content.' },
      },
      required: ['sessionId', 'content'],
    },
  },
};

const sessionsSendSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('sessions_send', args),
};

export default sessionsSendSkill;
