import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'read',
  name: 'Read (Compat)',
  description: 'Demo-compat alias for safe file reads inside the workspace.',
  version: '1.0.0',
  category: 'Compatibility',
  functionName: 'read',
  tool: {
    name: 'read',
    description: 'Read file content by path with optional line-range paging.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        from: { type: 'number', description: 'Start line (1-based).' },
        lines: { type: 'number', description: 'Number of lines to read.' },
        maxChars: { type: 'number', description: 'Maximum returned characters.' },
      },
      required: ['path'],
    },
  },
};

const readSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('read', args),
};

export default readSkill;
