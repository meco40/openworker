import { describe, expect, it } from 'vitest';

import { buildSystemInstruction } from '@/modules/app-shell/systemInstruction';

describe('buildSystemInstruction', () => {
  it('appends clawhub prompt block when present', () => {
    const instruction = buildSystemInstruction({
      baseInstruction: 'BASE',
      personaFiles: null,
      clawHubPromptBlock: 'CLAWHUB_BLOCK',
    });

    expect(instruction).toContain('BASE');
    expect(instruction).toContain('CLAWHUB_BLOCK');
  });

  it('prefers persona instruction stack over base instruction', () => {
    const instruction = buildSystemInstruction({
      baseInstruction: 'BASE',
      personaFiles: {
        'SOUL.md': 'SOUL',
        'AGENTS.md': 'AGENT',
        'USER.md': 'USER',
      },
      clawHubPromptBlock: '',
    });

    expect(instruction).toContain('SOUL');
    expect(instruction).toContain('AGENT');
    expect(instruction).toContain('USER');
    expect(instruction).not.toContain('\nBASE\n');
  });
});
