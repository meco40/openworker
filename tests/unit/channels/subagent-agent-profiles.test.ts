import { describe, expect, it } from 'vitest';
import {
  listSubagentAgentProfiles,
  resolveSubagentAgentProfile,
} from '@/server/channels/messages/service/subagent/agentProfiles';

describe('subagent agent profiles', () => {
  it('resolves qa profile with playwright cli capabilities', () => {
    const profile = resolveSubagentAgentProfile('qa');
    expect(profile).not.toBeNull();
    expect(profile?.id).toBe('qa');
    expect(profile?.toolFunctionNames).toContain('playwright_cli');
    expect(profile?.skillIds).toContain('playwright-cli');
  });

  it('supports alias resolution and keeps profile catalog stable', () => {
    const aliasProfile = resolveSubagentAgentProfile('playwright');
    expect(aliasProfile?.id).toBe('qa');

    const profiles = listSubagentAgentProfiles();
    expect(profiles.some((profile) => profile.id === 'worker')).toBe(true);
    expect(profiles.some((profile) => profile.id === 'qa')).toBe(true);
  });
});
