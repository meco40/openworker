/**
 * Unit tests for src/server/skills/skillMd/parser.ts
 */

import { describe, it, expect } from 'vitest';

import { parseSkillMd } from '@/server/skills/skillMd/parser';

const BUILT_IN_MD = `---
id: browser
emoji: 🌐
---

Use this skill to interact with web browsers.
`;

const USER_MD = `---
id: my-skill
name: My Skill
description: Does something useful.
version: 1.0.0
category: Custom
functionName: my_skill
tool:
  name: my_skill
  description: Does something.
  parameters:
    type: object
    properties:
      input:
        type: string
        description: Input text.
    required:
      - input
---

Here is guidance for the model.
`;

const CRLF_MD = '---\r\nid: crlf-skill\r\n---\r\n\nBody text here.';

describe('parseSkillMd', () => {
  it('parses a Tier-1 (built-in) SKILL.md correctly', () => {
    const result = parseSkillMd(BUILT_IN_MD, '/path/SKILL.md', 'bundled');
    expect(result.tier).toBe('built-in');
    expect(result.frontmatter.id).toBe('browser');
    expect((result.frontmatter as { emoji?: string }).emoji).toBe('🌐');
    expect(result.body).toBe('Use this skill to interact with web browsers.');
    expect(result.source).toBe('bundled');
  });

  it('parses a Tier-2 (user) SKILL.md correctly', () => {
    const result = parseSkillMd(USER_MD, '/path/SKILL.md', 'user');
    expect(result.tier).toBe('user');
    expect(result.frontmatter.id).toBe('my-skill');
    const fm = result.frontmatter as { name: string; functionName: string };
    expect(fm.name).toBe('My Skill');
    expect(fm.functionName).toBe('my_skill');
    expect(result.body).toBe('Here is guidance for the model.');
    expect(result.source).toBe('user');
  });

  it('throws when frontmatter block is missing', () => {
    expect(() => parseSkillMd('No frontmatter here', '/path/SKILL.md', 'bundled')).toThrow(
      /missing a YAML frontmatter block/,
    );
  });

  it('throws when id field is absent', () => {
    const noId = `---\nemoji: 🌐\n---\n\nBody.`;
    expect(() => parseSkillMd(noId, '/path/SKILL.md', 'bundled')).toThrow(
      /missing a required string "id"/,
    );
  });

  it('throws when a Tier-2 file is missing required fields', () => {
    const partial = `---\nid: broken\ntool:\n  name: broken_tool\n---\n\nBody.`;
    expect(() => parseSkillMd(partial, '/path/SKILL.md', 'user')).toThrow(
      /missing required fields/,
    );
  });

  it('handles CRLF line endings correctly', () => {
    const result = parseSkillMd(CRLF_MD, '/path/SKILL.md', 'bundled');
    expect(result.tier).toBe('built-in');
    expect(result.frontmatter.id).toBe('crlf-skill');
    expect(result.body).toBe('Body text here.');
  });
});
