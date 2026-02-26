export interface SubagentAgentProfile {
  id: string;
  aliases: string[];
  name: string;
  description: string;
  skillIds: string[];
  toolFunctionNames: string[];
  defaultGuidance?: string;
}

const PROFILES: SubagentAgentProfile[] = [
  {
    id: 'worker',
    aliases: ['default', 'general'],
    name: 'Worker',
    description: 'General execution agent with full tool access.',
    skillIds: ['shell-access', 'python-runtime', 'filesystem', 'process-manager'],
    toolFunctionNames: [],
  },
  {
    id: 'planner',
    aliases: ['architect'],
    name: 'Planner',
    description: 'Planning and decomposition agent with analysis-oriented tools.',
    skillIds: ['filesystem', 'web-search', 'web-fetch', 'sql-bridge'],
    toolFunctionNames: ['file_read', 'web_search', 'web_fetch', 'db_query'],
  },
  {
    id: 'researcher',
    aliases: ['research'],
    name: 'Researcher',
    description: 'Research-focused agent for web and repository investigation.',
    skillIds: ['web-search', 'web-fetch', 'browser', 'github-manager', 'filesystem'],
    toolFunctionNames: ['web_search', 'web_fetch', 'browser_snapshot', 'github_query', 'file_read'],
  },
  {
    id: 'qa',
    aliases: ['playwright', 'tester'],
    name: 'QA Playwright',
    description: 'Browser QA agent using Playwright CLI and shell verification.',
    skillIds: ['playwright-cli', 'shell-access', 'filesystem', 'process-manager'],
    toolFunctionNames: ['playwright_cli', 'shell_execute', 'file_read', 'process_manager'],
    defaultGuidance:
      'Execute deterministic browser QA steps with Playwright CLI and report failures with actionable details.',
  },
];

function normalizeAgentId(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

export function listSubagentAgentProfiles(): SubagentAgentProfile[] {
  return PROFILES.map((profile) => ({
    ...profile,
    aliases: [...profile.aliases],
    skillIds: [...profile.skillIds],
    toolFunctionNames: [...profile.toolFunctionNames],
  }));
}

export function resolveSubagentAgentProfile(agentId: string): SubagentAgentProfile | null {
  const normalized = normalizeAgentId(agentId);
  if (!normalized) return null;

  const profile = PROFILES.find((entry) => {
    if (entry.id === normalized) return true;
    return entry.aliases.some((alias) => normalizeAgentId(alias) === normalized);
  });
  if (!profile) return null;
  return {
    ...profile,
    aliases: [...profile.aliases],
    skillIds: [...profile.skillIds],
    toolFunctionNames: [...profile.toolFunctionNames],
  };
}
