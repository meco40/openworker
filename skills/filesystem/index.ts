
import { geminiSpec } from './gemini';
import { executeSkillApi } from '../runtime-client';

export default {
  id: 'filesystem',
  providers: {
    gemini: geminiSpec
  },
  execute: async (args: { path: string }) => {
    return executeSkillApi('file_read', args);
  }
};
