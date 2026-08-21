import { afterEach, describe, expect, it } from 'vitest';
import { getMissionControlUrl, getProjectsPath } from '@/lib/config';

const originalMissionControlUrl = process.env.MISSION_CONTROL_URL;
const originalProjectsPath = process.env.PROJECTS_PATH;
const originalPort = process.env.PORT;

function restoreEnvironment(): void {
  if (originalMissionControlUrl === undefined) delete process.env.MISSION_CONTROL_URL;
  else process.env.MISSION_CONTROL_URL = originalMissionControlUrl;

  if (originalProjectsPath === undefined) delete process.env.PROJECTS_PATH;
  else process.env.PROJECTS_PATH = originalProjectsPath;

  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
}

describe('runtime path configuration', () => {
  afterEach(restoreEnvironment);

  it('uses the configured callback URL', () => {
    process.env.MISSION_CONTROL_URL = 'https://runtime.example.com';

    expect(getMissionControlUrl()).toBe('https://runtime.example.com');
  });

  it('falls back to the local callback URL and configured port', () => {
    delete process.env.MISSION_CONTROL_URL;
    process.env.PORT = '4000';

    expect(getMissionControlUrl()).toBe('http://localhost:4000');
  });

  it('uses the configured projects path', () => {
    process.env.PROJECTS_PATH = 'C:/runtime/projects';

    expect(getProjectsPath()).toBe('C:/runtime/projects');
  });

  it('falls back to the shared projects path', () => {
    delete process.env.PROJECTS_PATH;

    expect(getProjectsPath()).toBe('~/Documents/Shared/projects');
  });
});
