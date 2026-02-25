import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'subagents',
  name: 'Subagents',
  description: 'Spawn and manage delegated helper agents for complex tasks.',
  version: '1.0.0',
  category: 'Automation',
  functionName: 'subagents',
  tool: {
    name: 'subagents',
    description:
      'Manage delegated helper agents: list, spawn, kill, steer, inspect logs or status.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Operation to execute.',
          enum: ['list', 'spawn', 'kill', 'steer', 'info', 'log', 'help', 'profiles'],
        },
        agentId: {
          type: 'string',
          description: 'Logical helper id/profile for spawn (example: researcher or qa).',
        },
        task: {
          type: 'string',
          description: 'Task text for spawn.',
        },
        target: {
          type: 'string',
          description: 'Run target for kill/steer/info/log (run id, prefix, or #index).',
        },
        message: {
          type: 'string',
          description: 'Guidance text for steer.',
        },
        model: {
          type: 'string',
          description: 'Optional model override for spawned run.',
        },
      },
      required: [],
    },
  },
};

const subagentsSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('subagents', args),
};

export default subagentsSkill;
