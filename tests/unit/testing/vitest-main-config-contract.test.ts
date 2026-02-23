import { describe, expect, it } from 'vitest';
import mainConfig from '../../../vitest.config';

type InlineProject = {
  name?: string | { label?: string };
  isolate?: boolean;
  include?: string[];
  exclude?: string[];
  test?: {
    name?: string | { label?: string };
    isolate?: boolean;
    include?: string[];
    exclude?: string[];
  };
};

const resolveProject = (value: unknown): InlineProject | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return value as InlineProject;
};

const resolveProjectTest = (
  project: InlineProject,
): NonNullable<InlineProject['test']> | InlineProject => project.test ?? project;

const resolveProjectName = (project: InlineProject): string | undefined => {
  const config = resolveProjectTest(project);
  if (typeof config.name === 'string') {
    return config.name;
  }
  return config.name?.label;
};

describe('main vitest config', () => {
  it('separates unit fast lane from isolated unit-interference lane and isolated core lane while keeping e2e out', () => {
    const rawProjects = mainConfig.test?.projects ?? [];
    const projects = rawProjects
      .map(resolveProject)
      .filter((value): value is InlineProject => Boolean(value));

    const unitFast = projects.find((project) => resolveProjectName(project) === 'unit-fast');
    const unitIsolated = projects.find(
      (project) => resolveProjectName(project) === 'unit-isolated',
    );
    const coreIsolated = projects.find(
      (project) => resolveProjectName(project) === 'core-isolated',
    );

    expect(unitFast).toBeDefined();
    expect(unitIsolated).toBeDefined();
    expect(coreIsolated).toBeDefined();

    const unitFastConfig = resolveProjectTest(unitFast as InlineProject);
    const unitIsolatedConfig = resolveProjectTest(unitIsolated as InlineProject);
    const coreIsolatedConfig = resolveProjectTest(coreIsolated as InlineProject);

    expect(unitFastConfig.isolate).toBe(false);
    expect(unitFastConfig.include).toEqual(['tests/unit/**/*.test.ts']);
    expect(unitFastConfig.exclude).toEqual([
      'tests/unit/channels/message-service-*.test.ts',
      'tests/unit/channels/telegram-*.test.ts',
    ]);

    expect(unitIsolatedConfig.isolate).toBe(true);
    expect(unitIsolatedConfig.include).toEqual([
      'tests/unit/channels/message-service-*.test.ts',
      'tests/unit/channels/telegram-*.test.ts',
    ]);

    expect(coreIsolatedConfig.isolate).toBe(true);
    expect(coreIsolatedConfig.include).toEqual(['tests/**/*.test.ts']);
    expect(coreIsolatedConfig.exclude).toEqual([
      'tests/unit/**/*.test.ts',
      'tests/e2e/**/*.e2e.test.ts',
    ]);
  });
});
