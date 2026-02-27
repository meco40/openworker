import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'memory-get',
  name: 'Memory Get (Compat)',
  description: 'Read line ranges from MEMORY.md and memory/*.md.',
  version: '1.0.0',
  category: 'Compatibility',
  functionName: 'memory_get',
  tool: {
    name: 'memory_get',
    description: 'Read a snippet from memory markdown files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to MEMORY.md or memory/*.md.' },
        from: { type: 'number', description: 'Start line (1-based).' },
        lines: { type: 'number', description: 'Line count to read.' },
      },
      required: ['path'],
    },
  },
};

const memoryGetSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('memory_get', args),
};

export default memoryGetSkill;
