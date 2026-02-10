import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '../runtime-client';

const manifest: SkillManifest = {
  id: 'python-runtime',
  name: 'Python Executor',
  description: 'Lokale REPL für Data Science, Plotting und Logik.',
  version: '3.11.2',
  category: 'Automation',
  functionName: 'python_execute',
  tool: {
    name: 'python_execute',
    description:
      'Execute Python code in a safe REPL environment for calculations or data analysis.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The Python source code to execute.' },
      },
      required: ['code'],
    },
  },
};

export default {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('python_execute', args),
};
