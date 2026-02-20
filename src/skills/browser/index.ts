import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'browser',
  name: 'Managed Browser',
  description: 'CDP-gesteuerter Chromium Browser für Snapshots und Interaktionen.',
  version: '1.0.2',
  category: 'Web',
  functionName: 'browser_snapshot',
  tool: {
    name: 'browser_snapshot',
    description: 'Fetch and inspect a web page to return title, metadata and excerpt.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target URL to inspect.' },
        format: { type: 'string', description: 'png or jpeg' },
        quality: { type: 'number', description: '0-100' },
      },
      required: ['url'],
    },
  },
};

const browserSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('browser_snapshot', args),
};

export default browserSkill;
