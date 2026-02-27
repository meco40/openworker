import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'agents-list',
  name: 'Agents List (Compat)',
  description: 'List available agents for session targeting.',
  version: '1.0.0',
  category: 'Compatibility',
  functionName: 'agents_list',
  tool: {
    name: 'agents_list',
    description: 'List known agents.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
};

const agentsListSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('agents_list', args),
};

export default agentsListSkill;
