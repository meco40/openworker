import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '../runtime-client';

const manifest: SkillManifest = {
  id: 'github-manager',
  name: 'GitHub Connector',
  description: 'Repo-Management, Pull Requests und Code-Reviews.',
  version: '1.5.0',
  category: 'DevOps',
  functionName: 'github_query',
  tool: {
    name: 'github_query',
    description: 'Interact with GitHub repositories to manage code, issues, and PRs.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: "Target repository (e.g., 'facebook/react')" },
        action: {
          type: 'string',
          description: 'Action to perform',
          enum: ['list_issues', 'list_pulls', 'repo_info', 'search_code'],
        },
        query: { type: 'string', description: 'Search query if applicable' },
      },
      required: ['repo', 'action'],
    },
  },
};

export default {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('github_query', args),
};
