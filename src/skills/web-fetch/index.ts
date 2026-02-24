import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'web-fetch',
  name: 'Web Fetch',
  description: 'Lädt eine URL und gibt den bereinigten Textinhalt zurück.',
  version: '1.0.0',
  category: 'Intelligence',
  functionName: 'web_fetch',
  tool: {
    name: 'web_fetch',
    description:
      'Fetch a public URL and return its cleaned text content. Useful for reading documentation, articles, APIs, or any webpage. HTML is converted to readable text. Not for private/internal URLs.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to fetch (must be a public HTTP/HTTPS URL).',
        },
        maxLength: {
          type: 'number',
          description: 'Maximum characters to return (default 8000, max 40000).',
        },
      },
      required: ['url'],
    },
  },
};

const webFetchSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('web_fetch', args),
};

export default webFetchSkill;
