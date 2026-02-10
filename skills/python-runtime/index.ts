
import { geminiSpec } from './gemini';
import { executeSkillApi } from '../runtime-client';

export default {
  id: 'python-runtime',
  providers: {
    gemini: geminiSpec
  },
  execute: async (args: { code: string }) => executeSkillApi('python_execute', args)
};
