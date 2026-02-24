import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'gateway-self-heal',
  name: 'Gateway Self-Heal',
  description:
    'Allows the agent to inspect and restart the gateway server process. Owner-only. ' +
    'Use when recovering from corrupted state or memory growth.',
  version: '1.0.0',
  category: 'System',
  functionName: 'gateway_self_heal',
  tool: {
    name: 'gateway_self_heal',
    description:
      'Inspect and restart the gateway server process (owner-only).\n' +
      '- status: return current pid, uptime, memory usage\n' +
      '- restart: schedule a graceful SIGTERM restart\n\n' +
      'WARNING: restart will terminate the server — the user connection will drop temporarily.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'restart'],
          description: 'Action to perform.',
        },
        reason: {
          type: 'string',
          description: '[restart] Human-readable reason for the restart.',
        },
        delay_ms: {
          type: 'number',
          description: '[restart] Milliseconds before sending SIGTERM. Default: 2000 (max 30000).',
        },
        force: {
          type: 'boolean',
          description:
            '[restart] If true, sends SIGKILL instead of SIGTERM (use only when graceful shutdown fails).',
        },
      },
      required: ['action'],
    },
  },
};

const gatewaySelfHealSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('gateway_self_heal', args),
};

export default gatewaySelfHealSkill;
