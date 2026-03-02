import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('wave1 refactor contracts', () => {
  it('shares task hydration mapper across task routes', () => {
    const tasksRoute = read('app/api/tasks/route.ts');
    const taskByIdRoute = read('app/api/tasks/[id]/route.ts');

    expect(tasksRoute).toContain("from '@/server/tasks/taskHydration'");
    expect(taskByIdRoute).toContain("from '@/server/tasks/taskHydration'");
    expect(tasksRoute).not.toContain('function hydrateTaskRelations(');
    expect(taskByIdRoute).not.toContain('function hydrateTaskRelations(');
  });

  it('uses centralized integer parsing helpers in server and ui layers', () => {
    const memoryApiShared = read('src/server/memory/api/shared.ts');
    const graphRoute = read('app/api/knowledge/graph/route.ts');
    const turnsRoute = read('app/api/debug/conversations/[id]/turns/route.ts');
    const profileHelpers = read('src/components/profile/utils/profileHelpers.ts');

    expect(memoryApiShared).toContain("from '@/server/http/params'");
    expect(graphRoute).toContain("from '@/server/http/params'");
    expect(turnsRoute).toContain("from '@/server/http/params'");
    expect(profileHelpers).toContain("from '@/components/shared/number'");
    expect(memoryApiShared).not.toContain('function parsePositiveInt(');
    expect(graphRoute).not.toContain('function parsePositiveInt(');
    expect(turnsRoute).not.toContain('function parsePositiveInt(');
  });

  it('removes client boundary directives from pure type files', () => {
    const promptLogTypes = read('src/components/stats/prompt-logs/types.ts');
    const profileTypes = read('src/components/profile/types.ts');
    const personaEditorTypes = read('src/components/personas/editor/types.ts');

    expect(promptLogTypes).not.toContain("'use client';");
    expect(profileTypes).not.toContain("'use client';");
    expect(personaEditorTypes).not.toContain("'use client';");
  });

  it('removes deprecated retrieval compat wrapper', () => {
    const compatPath = path.join(process.cwd(), 'src/server/knowledge/retrieval/service.ts');
    expect(fs.existsSync(compatPath)).toBe(false);
  });

  it('does not monkey patch providers.setProbeResult in useModelHub', () => {
    const useModelHub = read('src/components/model-hub/hooks/useModelHub.ts');

    expect(useModelHub).not.toContain('providers.setProbeResult = (result: string | null) => {');
    expect(useModelHub).not.toContain('providers.setProbeResult = originalSetProbeResult;');
  });
});
