import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type React from 'react';

import SkillsRegistry from '@/skills/SkillsRegistry';
import type { Skill } from '@/shared/domain/types';

function noopSetSkills(
  _updater: React.SetStateAction<Skill[]> | ((prevState: Skill[]) => Skill[]),
) {
  // no-op
}

describe('SkillsRegistry', () => {
  it('renders a clear button for ClawHub search reset', () => {
    const html = renderToStaticMarkup(
      createElement(SkillsRegistry, {
        skills: [],
        setSkills: () => {
          // no-op
        },
      }),
    );

    expect(html).toContain('aria-label="Clear ClawHub search"');
  });

  it('renders registry tabs for Skills and Tool Configuration', () => {
    const html = renderToStaticMarkup(
      createElement(SkillsRegistry, {
        skills: [],
        setSkills: noopSetSkills,
      }),
    );

    expect(html).toContain('Skills');
    expect(html).toContain('Tool Configuration');
  });

  it('renders skill cards by default tab', () => {
    const html = renderToStaticMarkup(
      createElement(SkillsRegistry, {
        skills: [
          {
            id: 'vision',
            name: 'Live Vision',
            description: 'Analyze images and scenes.',
            category: 'Media',
            installed: true,
            version: '2.4.0',
            functionName: 'vision_analyze',
            source: 'built-in',
          },
        ],
        setSkills: noopSetSkills,
      }),
    );

    expect(html).toContain('aria-label="Open info for Live Vision"');
  });
});
