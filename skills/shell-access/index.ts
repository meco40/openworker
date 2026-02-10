import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '../runtime-client';

const manifest: SkillManifest = {
  id: 'shell-access',
  name: 'Safe Shell',
  description: 'Gekapselter Zugriff auf Bash/ZSH für Systemmanagement.',
  version: '2.1.0',
  category: 'Automation',
  functionName: 'shell_execute',
  tool: {
    name: 'shell_execute',
    description: 'Execute a shell command in the isolated workspace terminal.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: "The shell command to run (e.g., 'ls -la')." },
      },
      required: ['command'],
    },
  },
};

export default {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('shell_execute', args),
};
