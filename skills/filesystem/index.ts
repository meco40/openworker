import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '../runtime-client';

const manifest: SkillManifest = {
  id: 'filesystem',
  name: 'File Gateway',
  description: 'Sandbox-Zugriff auf lokale Dateien und Downloads.',
  version: '0.9.8',
  category: 'System',
  functionName: 'file_read',
  tool: {
    name: 'file_read',
    description: 'Read the content of a file in the workspace sandbox safely.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file within the sandbox.' },
      },
      required: ['path'],
    },
  },
};

export default {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('file_read', args),
};
