import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'multi-tool-use-parallel',
  name: 'Multi Tool Use Parallel',
  description: 'Execute multiple independent tool calls in parallel and aggregate results.',
  version: '1.0.0',
  category: 'Automation',
  functionName: 'multi_tool_use.parallel',
  tool: {
    name: 'multi_tool_use.parallel',
    description: 'Run multiple tool calls in parallel.',
    parameters: {
      type: 'object',
      properties: {
        tool_uses: {
          type: 'array',
          description:
            'List of tool call entries. Each entry can carry name/recipient_name plus args/parameters.',
          items: {
            type: 'object',
            description: 'Tool call entry object.',
          },
        },
      },
      required: ['tool_uses'],
    },
  },
};

const multiToolUseParallelSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('multi_tool_use.parallel', args),
};

export default multiToolUseParallelSkill;
