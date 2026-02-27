import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'exec',
  name: 'Exec (Compat)',
  description: 'Demo-compat alias for shell command execution.',
  version: '1.0.0',
  category: 'Compatibility',
  functionName: 'exec',
  tool: {
    name: 'exec',
    description: 'Alias of shell_execute for demo tool compatibility.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
      },
      required: ['command'],
    },
  },
};

const execSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('exec', args),
};

export default execSkill;
