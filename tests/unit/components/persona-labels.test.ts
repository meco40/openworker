import { describe, expect, it } from 'vitest';

import { FILE_LABELS } from '../../../components/personas/personaLabels';

describe('persona labels', () => {
  it('contains labels for all supported persona files', () => {
    expect(FILE_LABELS['SOUL.md']).toBe('Soul');
    expect(FILE_LABELS['IDENTITY.md']).toBe('Identity');
    expect(FILE_LABELS['AGENTS.md']).toBe('Agents');
    expect(FILE_LABELS['USER.md']).toBe('User');
    expect(FILE_LABELS['TOOLS.md']).toBe('Tools');
    expect(FILE_LABELS['HEARTBEAT.md']).toBe('Heartbeat');
  });
});
