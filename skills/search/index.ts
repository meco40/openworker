
import { geminiSpec } from './gemini';

export default {
  id: 'search',
  providers: {
    gemini: geminiSpec
  },
  execute: async () => {
    return "Search completed via Grounding.";
  }
};
