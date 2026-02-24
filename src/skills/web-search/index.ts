import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'web-search',
  name: 'Web Search',
  description: 'Sucht im Web via Brave Search API (mit DuckDuckGo-Fallback).',
  version: '1.0.0',
  category: 'Intelligence',
  functionName: 'web_search',
  tool: {
    name: 'web_search',
    description:
      'Search the web for current information. Returns a list of results with titles, URLs, and snippets. Use for real-time information, news, documentation, or any topic that may have changed recently.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query string.',
        },
        count: {
          type: 'number',
          description: 'Number of results to return (1–20, default 5).',
        },
      },
      required: ['query'],
    },
  },
};

const webSearchSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('web_search', args),
};

export default webSearchSkill;
