import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'browser-tool',
  name: 'Browser (Compat)',
  description: 'Demo-compat browser tool wrapper for status and lightweight snapshot actions.',
  version: '1.0.0',
  category: 'Compatibility',
  functionName: 'browser',
  tool: {
    name: 'browser',
    description: 'Browser compatibility wrapper (status, snapshot/open, tabs, profiles).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Browser action.' },
        url: { type: 'string', description: 'Target URL for open/snapshot.' },
        targetUrl: { type: 'string', description: 'Alias target URL for open/snapshot.' },
      },
      required: ['action'],
    },
  },
};

const browserToolSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('browser', args),
};

export default browserToolSkill;
