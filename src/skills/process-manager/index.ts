import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'process-manager',
  name: 'Process Manager',
  description:
    'Start and manage long-running background processes (servers, watchers, etc.) across multiple tool calls. Use this when shell_execute would block forever.',
  version: '1.0.0',
  category: 'Automation',
  functionName: 'process_manager',
  tool: {
    name: 'process_manager',
    description:
      'Manage long-running background processes across tool calls.\n' +
      '- start: spawn a process, returns id\n' +
      '- poll / log: read buffered stdout+stderr output (non-blocking)\n' +
      '- write: send text to stdin\n' +
      '- kill: terminate a process\n' +
      '- list: list all managed processes\n\n' +
      'NOTE: Uses pipe stdio (no PTY). Interactive programs (vim, sudo with password, etc.) will not work.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'poll', 'log', 'write', 'kill', 'list'],
          description: 'The action to perform.',
        },
        command: {
          type: 'string',
          description: '[start] The shell command to run.',
        },
        id: {
          type: 'string',
          description: '[poll, log, write, kill] The process id returned by start.',
        },
        label: {
          type: 'string',
          description: '[start] Human-readable label for the process (e.g. "dev-server").',
        },
        cwd: {
          type: 'string',
          description: '[start] Working directory for the process.',
        },
        text: {
          type: 'string',
          description: '[write] Text to write to the process stdin.',
        },
        bytes: {
          type: 'number',
          description:
            '[poll, log] Maximum tail bytes to return from output buffer. Default: 4000.',
        },
        signal: {
          type: 'string',
          description: '[kill] Signal to send (default SIGTERM).',
        },
        start_timeout_ms: {
          type: 'number',
          description:
            '[start] Milliseconds to wait for early crash detection before returning process id. Default: 2000.',
        },
      },
      required: ['action'],
    },
  },
};

const processManagerSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('process_manager', args),
};

export default processManagerSkill;
