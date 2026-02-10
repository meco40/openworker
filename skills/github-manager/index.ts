
import { geminiSpec } from './gemini';
import { executeSkillApi } from '../runtime-client';

export default {
  id: 'github-manager',
  providers: {
    gemini: geminiSpec
  },
  execute: async (args: any) => executeSkillApi('github_query', args)
};
