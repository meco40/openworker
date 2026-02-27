import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'message',
  name: 'Message (Compat)',
  description: 'Demo-compat message send/read/delete tool wrapper.',
  version: '1.0.0',
  category: 'Compatibility',
  functionName: 'message',
  tool: {
    name: 'message',
    description: 'Send, read, or delete messages through integrated OpenClaw APIs.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action: send, read, or delete.' },
        to: { type: 'string', description: 'Target session key for send/read.' },
        sessionKey: { type: 'string', description: 'Session key for send/read.' },
        content: { type: 'string', description: 'Message content for send.' },
        messageId: { type: 'string', description: 'Message id for delete.' },
        conversationId: { type: 'string', description: 'Conversation id for delete.' },
        limit: { type: 'number', description: 'History limit for read.' },
      },
      required: ['action'],
    },
  },
};

const messageSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('message', args),
};

export default messageSkill;
