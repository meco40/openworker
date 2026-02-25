import { describe, expect, it } from 'vitest';
import { buildActiveSkillsPromptSection } from '@/server/channels/messages/service/dispatchers/skillsPrompt';
import type { BuiltInSkillSeed } from '@/server/skills/builtInSkills';
import type { SkillRow } from '@/server/skills/skillRepository';
import type { ParsedSkillMd } from '@/server/skills/skillMd';
import type { SkillToolDefinition } from '@/shared/toolSchema';

const TOOL: SkillToolDefinition = {
  name: 'demo_tool',
  description: 'Demo tool',
  parameters: {
    type: 'object',
    properties: {},
  },
};

function makeSkillRow(
  id: string,
  name: string,
  functionName: string,
  installed = true,
  source: SkillRow['source'] = 'built-in',
): SkillRow {
  return {
    id,
    name,
    description: `${name} description`,
    category: 'Utility',
    version: '1.0.0',
    installed,
    functionName,
    source,
    sourceUrl: null,
    toolDefinition: TOOL,
    handlerPath: null,
    createdAt: '2026-02-25T00:00:00.000Z',
    updatedAt: '2026-02-25T00:00:00.000Z',
  };
}

function makeBuiltInSeed(id: string, name: string, functionName: string): BuiltInSkillSeed {
  return {
    installedByDefault: true,
    manifest: {
      id,
      name,
      description: `${name} description`,
      version: '1.0.0',
      category: 'Utility',
      functionName,
      tool: TOOL,
    },
  };
}

describe('buildActiveSkillsPromptSection', () => {
  it('includes only installed skills and excludes disabled built-ins', () => {
    const installedSkills: SkillRow[] = [makeSkillRow('browser', 'Managed Browser', 'browser_snapshot')];
    const eligibleParsedSkills: ParsedSkillMd[] = [
      {
        tier: 'built-in',
        frontmatter: { id: 'browser', emoji: '🌐' },
        body: 'Use browser for page inspection.',
        filePath: '/tmp/browser/SKILL.md',
        source: 'bundled',
      },
      {
        tier: 'built-in',
        frontmatter: { id: 'shell-access', emoji: '🖥️' },
        body: 'Use shell tool.',
        filePath: '/tmp/shell/SKILL.md',
        source: 'bundled',
      },
    ];
    const builtInSeeds: BuiltInSkillSeed[] = [
      makeBuiltInSeed('browser', 'Managed Browser', 'browser_snapshot'),
      makeBuiltInSeed('shell-access', 'Shell Access', 'shell_execute'),
    ];

    const section = buildActiveSkillsPromptSection({
      installedSkills,
      eligibleParsedSkills,
      builtInSeeds,
    });

    expect(section).toContain('## Skill Guidance');
    expect(section).toContain('Managed Browser (`browser_snapshot`)');
    expect(section).toContain('Use browser for page inspection.');
    expect(section).not.toContain('Shell Access (`shell_execute`)');
    expect(section).not.toContain('Use shell tool.');
  });

  it('lists installed skills even when no SKILL.md body exists', () => {
    const installedSkills: SkillRow[] = [
      makeSkillRow('process-manager', 'Process Manager', 'process_manager'),
    ];
    const eligibleParsedSkills: ParsedSkillMd[] = [];
    const builtInSeeds: BuiltInSkillSeed[] = [];

    const section = buildActiveSkillsPromptSection({
      installedSkills,
      eligibleParsedSkills,
      builtInSeeds,
    });

    expect(section).toContain('Process Manager (`process_manager`)');
    expect(section).toContain('Active skill from registry (no SKILL.md guidance loaded).');
  });
});
