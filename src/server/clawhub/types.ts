export interface ClawHubSearchItem {
  slug: string;
  version: string;
  title: string;
  score: number;
}

export interface ClawHubSearchParseResult {
  items: ClawHubSearchItem[];
  parseWarnings: string[];
}

export interface ClawHubCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
  argv: string[];
}

export interface ClawHubCliLike {
  run(command: string, args: string[]): Promise<ClawHubCliResult>;
}

export interface ClawHubSkillRow {
  slug: string;
  version: string;
  title: string;
  status: 'installed' | 'error';
  enabled: boolean;
  localPath: string;
  installedAt: string | null;
  lastActionAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface UpsertClawHubSkillInput {
  slug: string;
  version: string;
  title: string;
  status: 'installed' | 'error';
  enabled?: boolean;
  localPath: string;
  installedAt?: string | null;
  lastActionAt?: string | null;
  lastError?: string | null;
}
