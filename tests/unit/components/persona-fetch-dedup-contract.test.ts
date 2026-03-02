import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('persona fetch dedupe contract', () => {
  it('uses context-level persona loader dedupe and wires it into persona selection hook', () => {
    const personaContext = read('src/modules/personas/PersonaContext.tsx');
    const personaSelectionHook = read('src/components/personas/hooks/usePersonaSelection.ts');
    const personasView = read('src/components/PersonasView.tsx');

    expect(personaContext).toContain('personaLoadPromisesRef');
    expect(personaContext).toContain('loadPersonaById');
    expect(personaContext).toContain('patchPersonaFile');
    expect(personaSelectionHook).toContain('loadPersonaById?: (id: string) => Promise');
    expect(personaSelectionHook).toContain('onPersonaFilePatched?:');
    expect(personaSelectionHook).toContain('const loader = loadPersonaById');
    expect(personaSelectionHook).toContain(
      'onPersonaFilePatched?.(selectedId, filename, content);',
    );
    expect(personasView).toContain('loadPersonaById,');
    expect(personasView).toContain('patchPersonaFile,');
    expect(personasView).toContain(
      'usePersonaSelection({ loadPersonaById, onPersonaFilePatched: patchPersonaFile })',
    );
  });
});
