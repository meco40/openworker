import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SkillRepository } from '@/server/skills/skillRepository';
import type { BuiltInSkillSeed } from '@/server/skills/builtInSkills';
import type { SkillManifest } from '@/shared/toolSchema';

const TEST_DB_DIR = path.join(process.cwd(), '.local', 'test');

const sampleManifest: SkillManifest = {
  id: 'test-skill',
  name: 'Test Skill',
  description: 'A test skill',
  version: '1.0.0',
  category: 'Testing',
  functionName: 'test_execute',
  tool: {
    name: 'test_execute',
    description: 'Execute a test.',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Test input.' },
      },
      required: ['input'],
    },
  },
};

const seeds: BuiltInSkillSeed[] = [{ manifest: sampleManifest, installedByDefault: true }];

let repo: SkillRepository;
let dbPath: string;
let counter = 0;

beforeEach(() => {
  counter++;
  dbPath = path.join(TEST_DB_DIR, `skills-test-${Date.now()}-${counter}.db`);
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  repo = new SkillRepository(dbPath);
});

afterEach(() => {
  repo.close();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
});

describe('SkillRepository', () => {
  describe('seedBuiltIns', () => {
    it('populates the database with built-in skills', () => {
      repo.seedBuiltIns(seeds);
      const skills = repo.listSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('test-skill');
      expect(skills[0].name).toBe('Test Skill');
      expect(skills[0].installed).toBe(true);
      expect(skills[0].source).toBe('built-in');
    });

    it('does not overwrite existing skills on re-seed', () => {
      repo.seedBuiltIns(seeds);
      repo.setInstalled('test-skill', false);
      repo.seedBuiltIns(seeds);
      const skill = repo.getSkill('test-skill');
      expect(skill).toBeDefined();
      expect(skill!.installed).toBe(false);
    });
  });

  describe('setInstalled', () => {
    it('toggles installed flag and persists across instances', () => {
      repo.seedBuiltIns(seeds);
      repo.setInstalled('test-skill', false);
      expect(repo.getSkill('test-skill')!.installed).toBe(false);

      repo.setInstalled('test-skill', true);
      expect(repo.getSkill('test-skill')!.installed).toBe(true);

      // Verify persistence with a new repo instance on same DB
      repo.close();
      const repo2 = new SkillRepository(dbPath);
      expect(repo2.getSkill('test-skill')!.installed).toBe(true);
      repo2.close();

      // Re-assign so afterEach doesn't fail
      repo = new SkillRepository(dbPath);
    });

    it('returns false for non-existent skill', () => {
      expect(repo.setInstalled('non-existent', true)).toBe(false);
    });
  });

  describe('installSkill', () => {
    it('adds a new external skill', () => {
      const installed = repo.installSkill({
        name: 'Weather',
        description: 'Get weather data.',
        category: 'Data',
        version: '1.0.0',
        functionName: 'weather_forecast',
        source: 'github',
        sourceUrl: 'https://github.com/user/weather-skill',
        toolDefinition: {
          name: 'weather_forecast',
          description: 'Get weather.',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'City name.' },
            },
            required: ['location'],
          },
        },
      });

      expect(installed.id).toBeDefined();
      expect(installed.name).toBe('Weather');
      expect(installed.source).toBe('github');
      expect(installed.installed).toBe(true);
      expect(installed.toolDefinition).toBeDefined();
    });
  });

  describe('removeSkill', () => {
    it('removes a skill from the database', () => {
      repo.seedBuiltIns(seeds);
      expect(repo.listSkills()).toHaveLength(1);
      const removed = repo.removeSkill('test-skill');
      expect(removed).toBe(true);
      expect(repo.listSkills()).toHaveLength(0);
    });

    it('returns false for non-existent skill', () => {
      expect(repo.removeSkill('non-existent')).toBe(false);
    });
  });
});
