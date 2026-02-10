
import { geminiSpec } from './gemini';
import { execute } from './logic';

export default {
  id: 'browser',
  providers: {
    gemini: geminiSpec,
    // claude: claudeSpec, // Example for future expansion
  },
  execute
};
