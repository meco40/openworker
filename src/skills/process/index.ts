import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'process',
  name: 'Process (Compat)',
  description: 'Demo-compat alias for process_manager.',
  version: '1.0.0',
  category: 'Compatibility',
  functionName: 'process',
  tool: {
    name: 'process',
    description: 'Alias of process_manager for demo tool compatibility.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Process action (start, poll, log, write, kill, list).',
        },
        command: { type: 'string', description: 'Command to run for action=start.' },
        id: { type: 'string', description: 'Managed process id for poll/log/write/kill.' },
        text: { type: 'string', description: 'Input text for action=write.' },
      },
      required: ['action'],
    },
  },
};

const processSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('process', args),
};

export default processSkill;
