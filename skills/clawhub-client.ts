export interface ClawHubSearchItem {
  slug: string;
  version: string;
  title: string;
  score: number;
}

export interface ClawHubSearchResponse {
  ok: boolean;
  items: ClawHubSearchItem[];
  parseWarnings?: string[];
  source?: string;
  error?: string;
}

export interface ClawHubInstalledSkill {
  slug: string;
  version: string;
  title: string;
  status: 'installed' | 'error';
  localPath: string;
  enabled: boolean;
}

export interface ClawHubInstalledResponse {
  ok: boolean;
  skills: ClawHubInstalledSkill[];
  error?: string;
}

export interface ClawHubInstallResponse {
  ok: boolean;
  skills: ClawHubInstalledSkill[];
  warnings?: string[];
  error?: string;
}

export interface ClawHubUpdateResponse {
  ok: boolean;
  skills: ClawHubInstalledSkill[];
  warnings?: string[];
  error?: string;
}

export interface ClawHubToggleResponse {
  ok: boolean;
  skill?: ClawHubInstalledSkill;
  error?: string;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function searchClawHubSkills(query: string, limit = 25): Promise<ClawHubSearchResponse> {
  const qs = new URLSearchParams({
    q: query,
    limit: String(limit),
  });
  const response = await fetch(`/api/clawhub/search?${qs.toString()}`);
  return readJson<ClawHubSearchResponse>(response);
}

export async function listInstalledClawHubSkills(): Promise<ClawHubInstalledResponse> {
  const response = await fetch('/api/clawhub/installed');
  return readJson<ClawHubInstalledResponse>(response);
}

export async function installClawHubSkill(input: {
  slug: string;
  version?: string;
  force?: boolean;
}): Promise<ClawHubInstallResponse> {
  const response = await fetch('/api/clawhub/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readJson<ClawHubInstallResponse>(response);
}

export async function updateClawHubSkill(input: {
  slug?: string;
  all?: boolean;
  version?: string;
  force?: boolean;
}): Promise<ClawHubUpdateResponse> {
  const response = await fetch('/api/clawhub/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readJson<ClawHubUpdateResponse>(response);
}

export async function setClawHubSkillEnabled(
  slug: string,
  enabled: boolean,
): Promise<ClawHubToggleResponse> {
  const response = await fetch(`/api/clawhub/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  return readJson<ClawHubToggleResponse>(response);
}
