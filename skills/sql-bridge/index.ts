
import { geminiSpec } from './gemini';
import { executeSkillApi } from '../runtime-client';

export default {
  id: 'sql-bridge',
  providers: {
    gemini: geminiSpec
  },
  execute: async (args: { query: string }) => {
    return executeSkillApi('db_query', args);
  }
};
