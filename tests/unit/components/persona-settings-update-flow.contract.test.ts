import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function countOccurrences(source: string, needle: string): number {
  if (!needle) return 0;
  return source.split(needle).length - 1;
}

describe('persona settings update flow contract', () => {
  it('centralizes persona PUT updates in PersonasView and keeps hook read-only', () => {
    const personasView = read('src/components/PersonasView.tsx');
    const pipelineHook = read('src/components/personas/hooks/usePipelineModels.ts');

    expect(personasView).toContain('const updatePersonaSetting = useCallback(');
    expect(personasView).toContain("selectedPersona?.systemPersonaKey === 'master'");
    expect(personasView).toContain('systemManagementHint=');
    expect(countOccurrences(personasView, "method: 'PUT'")).toBe(1);
    expect(pipelineHook).not.toContain('/api/personas/');
    expect(pipelineHook).not.toContain("method: 'PUT'");
  });
});
