import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPersonaProjectWorkspace,
  getPersonaProjectsDir,
  removePersonaProjectWorkspace,
  slugifyProjectName,
} from '@/server/personas/personaProjectWorkspace';

describe('persona project workspace', () => {
  const cleanupDirs: string[] = [];

  function createIsolatedPersonasRoot(): string {
    const rootPath = path.resolve(
      '.local',
      `personas.project.workspace.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    );
    cleanupDirs.push(rootPath);
    process.env.PERSONAS_ROOT_PATH = rootPath;
    return rootPath;
  }

  afterEach(() => {
    delete process.env.PERSONAS_ROOT_PATH;
    for (const dirPath of cleanupDirs.splice(0, cleanupDirs.length)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  });

  it('normalizes project names into safe slugs', () => {
    expect(slugifyProjectName('  Notes App  ')).toBe('notes_app');
    expect(slugifyProjectName('Next.js + CRUD!!!')).toBe('next_js_crud');
  });

  it('creates a new project workspace under the persona projects directory', () => {
    const personasRoot = createIsolatedPersonasRoot();
    const created = createPersonaProjectWorkspace({
      personaSlug: 'next_js_dev',
      task: 'Erstelle mir eine Notizen WebApp mit dem Namen Notes',
    });

    expect(created.absolutePath.startsWith(path.join(personasRoot, 'next_js_dev'))).toBe(true);
    expect(created.absolutePath.startsWith(getPersonaProjectsDir('next_js_dev'))).toBe(true);
    expect(fs.existsSync(created.absolutePath)).toBe(true);
    expect(fs.existsSync(path.join(created.absolutePath, 'PROJECT.md'))).toBe(true);
  });

  it('creates distinct workspace folders for separate task requests', () => {
    createIsolatedPersonasRoot();
    const first = createPersonaProjectWorkspace({
      personaSlug: 'next_js_dev',
      task: 'Baue Notes App',
    });
    const second = createPersonaProjectWorkspace({
      personaSlug: 'next_js_dev',
      task: 'Baue Notes App',
    });

    expect(first.projectId).not.toBe(second.projectId);
    expect(first.absolutePath).not.toBe(second.absolutePath);
  });

  it('removes project workspace safely inside persona projects directory', () => {
    createIsolatedPersonasRoot();
    const created = createPersonaProjectWorkspace({
      personaSlug: 'next_js_dev',
      task: 'Baue Notes App',
    });
    expect(fs.existsSync(created.absolutePath)).toBe(true);

    removePersonaProjectWorkspace({
      personaSlug: 'next_js_dev',
      workspacePath: created.absolutePath,
    });
    expect(fs.existsSync(created.absolutePath)).toBe(false);
  });

  it('rejects removal for paths outside the persona projects directory', () => {
    const personasRoot = createIsolatedPersonasRoot();
    const outsidePath = path.join(personasRoot, 'outside-workspace');
    fs.mkdirSync(outsidePath, { recursive: true });

    expect(() =>
      removePersonaProjectWorkspace({
        personaSlug: 'next_js_dev',
        workspacePath: outsidePath,
      }),
    ).toThrow(/outside/i);
    expect(fs.existsSync(outsidePath)).toBe(true);
  });
});
