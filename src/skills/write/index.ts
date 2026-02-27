import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'write',
  name: 'Write (Compat)',
  description: 'Demo-compat alias for writing files in the workspace.',
  version: '1.0.0',
  category: 'Compatibility',
  functionName: 'write',
  tool: {
    name: 'write',
    description: 'Write or append text to a workspace-relative file path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        content: { type: 'string', description: 'File content to write.' },
        append: { type: 'boolean', description: 'Append instead of overwrite when true.' },
      },
      required: ['path', 'content'],
    },
  },
};

const writeSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('write', args),
};

export default writeSkill;
