import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'memory-search',
  name: 'Memory Search (Compat)',
  description: 'Search MEMORY.md and memory/*.md snippets.',
  version: '1.0.0',
  category: 'Compatibility',
  functionName: 'memory_search',
  tool: {
    name: 'memory_search',
    description: 'Search memory markdown files by semantic token matching.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text.' },
        maxResults: { type: 'number', description: 'Maximum number of hits.' },
        minScore: { type: 'number', description: 'Minimum score between 0 and 1.' },
      },
      required: ['query'],
    },
  },
};

const memorySearchSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('memory_search', args),
};

export default memorySearchSkill;
