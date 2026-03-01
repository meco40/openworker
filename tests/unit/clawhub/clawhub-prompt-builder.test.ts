import fs from 'node:fs';
import path from 'node:path';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

import { afterEach, describe, expect, it } from 'vitest';

import { ClawHubRepository } from '@/server/clawhub/clawhubRepository';
import { buildClawHubPromptBlock } from '@/server/clawhub/clawhubPromptBuilder';

function uniqueDir(name: string): string {
  return path.join(
    getTestArtifactsRoot(),
    `${name}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
  );
}

describe('buildClawHubPromptBlock', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0, createdDirs.length)) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('includes only enabled skills with bounded excerpts', async () => {
    const rootDir = uniqueDir('clawhub.prompt');
    createdDirs.push(rootDir);

    fs.mkdirSync(path.join(rootDir, 'skills', 'calendar'), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, 'skills', 'calendar', 'SKILL.md'),
      [
        '---',
        'name: calendar',
        'description: Calendar management',
        '---',
        '',
        '# Calendar',
        'Manage events, reminders, and scheduling workflows.',
      ].join('\n'),
      'utf8',
    );

    const repo = new ClawHubRepository(':memory:');
    repo.upsertSkill({
      slug: 'calendar',
      version: '1.0.0',
      title: 'Calendar',
      status: 'installed',
      localPath: 'skills/calendar',
      enabled: true,
    });
    repo.upsertSkill({
      slug: 'private',
      version: '1.0.0',
      title: 'Private',
      status: 'installed',
      localPath: 'skills/private',
      enabled: false,
    });

    const prompt = await buildClawHubPromptBlock({
      workspaceDir: rootDir,
      repository: repo,
      maxSkills: 5,
      maxCharsPerSkill: 120,
      maxTotalChars: 500,
    });

    expect(prompt).toContain('calendar');
    expect(prompt).toContain('Calendar management');
    expect(prompt).not.toContain('private');
    expect(prompt.length).toBeLessThanOrEqual(500);
  });
});
