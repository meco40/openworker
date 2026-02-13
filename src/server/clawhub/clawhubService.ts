import fs from 'node:fs';
import path from 'node:path';

import { parseClawHubSearchOutput } from './searchParser';
import type {
  ClawHubCliLike,
  ClawHubSearchParseResult,
  ClawHubSkillRow,
  UpsertClawHubSkillInput,
} from './types';
import { ClawHubCli } from './clawhubCli';
import { ClawHubRepository, getClawHubRepository } from './clawhubRepository';
import { buildClawHubPromptBlock } from './clawhubPromptBuilder';

interface ClawHubLockFile {
  skills?: Record<
    string,
    {
      version?: string;
      installedAt?: number;
    }
  >;
}

export interface ClawHubServiceOptions {
  cli?: ClawHubCliLike;
  repository?: ClawHubRepository;
  workspaceDir?: string;
}

export interface ClawHubInstallInput {
  slug: string;
  version?: string;
  force?: boolean;
}

export interface ClawHubUpdateInput {
  slug?: string;
  all?: boolean;
  version?: string;
  force?: boolean;
}

function toIsoFromEpoch(value: number | undefined): string | null {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value).toISOString();
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseJsonObject<T>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

export class ClawHubService {
  private readonly cli: ClawHubCliLike;
  private readonly repository: ClawHubRepository;
  private readonly workspaceDir: string;

  constructor(options: ClawHubServiceOptions = {}) {
    this.cli = options.cli ?? new ClawHubCli({ workdir: options.workspaceDir });
    this.repository = options.repository ?? getClawHubRepository();
    this.workspaceDir = options.workspaceDir || process.env.CLAWHUB_WORKDIR || process.cwd();
  }

  async search(query: string, limit = 25): Promise<ClawHubSearchParseResult> {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 25;
    const result = await this.cli.run('search', ['--limit', String(safeLimit), query.trim()]);
    return parseClawHubSearchOutput(result.stdout);
  }

  async explore(limit = 25, sort = 'newest'): Promise<{ items: Array<Record<string, unknown>> }> {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 25;
    const safeSort = sort.trim() || 'newest';
    const result = await this.cli.run('explore', ['--json', '--limit', String(safeLimit), '--sort', safeSort]);
    const parsed = parseJsonObject<Array<Record<string, unknown>>>(result.stdout);
    return { items: parsed ?? [] };
  }

  async install(input: ClawHubInstallInput): Promise<{ skills: ClawHubSkillRow[]; warnings: string[] }> {
    const args = ['--force'];
    if (!input.force) {
      args.pop();
    }
    if (input.version?.trim()) {
      args.push('--version', input.version.trim());
    }
    args.push(input.slug.trim());
    await this.cli.run('install', args);
    const skills = await this.syncInstalledFromLockfile();
    return { skills, warnings: [] };
  }

  async update(input: ClawHubUpdateInput): Promise<{ skills: ClawHubSkillRow[]; warnings: string[] }> {
    const args: string[] = [];
    if (input.all) {
      args.push('--all');
    } else if (input.slug?.trim()) {
      args.push(input.slug.trim());
    }
    if (input.version?.trim()) {
      args.push('--version', input.version.trim());
    }
    if (input.force) {
      args.push('--force');
    }

    await this.cli.run('update', args);
    const skills = await this.syncInstalledFromLockfile();
    return { skills, warnings: [] };
  }

  async syncInstalledFromLockfile(): Promise<ClawHubSkillRow[]> {
    const lockPath = path.join(this.workspaceDir, '.clawhub', 'lock.json');
    const rawLock = readJsonFile(lockPath) as ClawHubLockFile | null;
    const lockSkills = rawLock?.skills || {};

    const keptSlugs: string[] = [];
    for (const [slug, entry] of Object.entries(lockSkills)) {
      const safeSlug = slug.trim();
      if (!safeSlug) {
        continue;
      }
      keptSlugs.push(safeSlug);

      const metaPath = path.join(this.workspaceDir, 'skills', safeSlug, '_meta.json');
      const meta = readJsonFile(metaPath);
      const titleCandidate = typeof meta?.title === 'string' ? meta.title.trim() : '';

      const input: UpsertClawHubSkillInput = {
        slug: safeSlug,
        version: entry.version?.trim() || 'unknown',
        title: titleCandidate || safeSlug,
        status: 'installed',
        localPath: path.join('skills', safeSlug).replace(/\\/g, '/'),
        installedAt: toIsoFromEpoch(entry.installedAt),
      };
      this.repository.upsertSkill(input);
    }

    this.repository.deleteNotIn(keptSlugs);
    return this.repository.listSkills();
  }

  async setEnabled(slug: string, enabled: boolean): Promise<ClawHubSkillRow> {
    const normalized = slug.trim();
    if (!normalized) {
      throw new Error('Skill slug is required.');
    }

    const updated = this.repository.setEnabled(normalized, enabled);
    if (!updated) {
      throw new Error(`ClawHub skill not found: ${normalized}`);
    }
    return this.repository.getSkill(normalized)!;
  }

  async getPromptBlock(): Promise<string> {
    return buildClawHubPromptBlock({
      workspaceDir: this.workspaceDir,
      repository: this.repository,
    });
  }
}

declare global {
  var __clawHubService: ClawHubService | undefined;
}

export function getClawHubService(): ClawHubService {
  if (!globalThis.__clawHubService) {
    globalThis.__clawHubService = new ClawHubService();
  }
  return globalThis.__clawHubService;
}
