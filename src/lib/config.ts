/** Runtime paths used by the task orchestration and callback services. */
export function getMissionControlUrl(): string {
  return process.env.MISSION_CONTROL_URL || `http://localhost:${process.env.PORT || '3000'}`;
}

export function getProjectsPath(): string {
  return process.env.PROJECTS_PATH || '~/Documents/Shared/projects';
}
