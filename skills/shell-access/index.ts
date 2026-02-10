
import { geminiSpec } from './gemini';
import { executeSkillApi } from '../runtime-client';

export default {
  id: 'shell-access',
  providers: {
    gemini: geminiSpec
  },
  execute: async (args: { command: string }) => executeSkillApi('shell_execute', args)
};
