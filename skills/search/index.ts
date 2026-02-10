import type { SkillManifest } from '@/shared/toolSchema';

const manifest: SkillManifest = {
  id: 'search',
  name: 'Google Search',
  description: 'Echtzeit-Webzugriff via Google Search Grounding.',
  version: '3.0.1',
  category: 'Intelligence',
  functionName: '__built_in__',
  tool: {
    builtIn: true,
    providerConfig: {
      gemini: { googleSearch: {} },
    },
  },
};

export default {
  ...manifest,
  execute: async () => 'Search completed via Grounding.',
};
