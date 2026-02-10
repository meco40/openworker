
import { geminiSpec } from './gemini';
import { executeSkillApi } from '../runtime-client';

export default {
  id: 'vision',
  providers: {
    gemini: geminiSpec
  },
  execute: async (args: any) => executeSkillApi('vision_analyze', args)
};
