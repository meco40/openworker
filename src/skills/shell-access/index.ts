import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'shell-access',
  name: 'Shell',
  description:
    'Runs commands on the host in the workspace directory. Not sandboxed: commands run with the server user permissions. Set BETACLAW_EXEC_APPROVALS_REQUIRED=true to require approval.',
  version: '2.1.0',
  category: 'Automation',
  functionName: 'shell_execute',
  tool: {
    name: 'shell_execute',
    description:
      'Run a shell command on the host in the workspace directory (PowerShell on Windows, /bin/sh elsewhere). Not sandboxed: runs with the server permissions.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: "The shell command to run (e.g., 'ls -la')." },
      },
      required: ['command'],
    },
  },
};

const shellAccessSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('shell_execute', args),
};

export default shellAccessSkill;
