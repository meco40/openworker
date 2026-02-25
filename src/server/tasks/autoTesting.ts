import crypto from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { queryAll, run } from '@/lib/db';
import { getMissionControlUrl, getProjectsPath } from '@/lib/config';

const MAX_DISCOVERED_HTML_FILES = 20;
const inFlightAutoTests = new Set<string>();

function expandHomePath(input: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return input;
  return input.replace(/^~(?=$|[\\/])/, home);
}

function buildTaskProjectSlug(taskTitle: string): string {
  return String(taskTitle || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function discoverHtmlFiles(rootDir: string): string[] {
  const results: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0 && results.length < MAX_DISCOVERED_HTML_FILES) {
    const current = stack.pop();
    if (!current) continue;

    let entries: Array<{ name: string; isDirectory: boolean; fullPath: string }> = [];
    try {
      entries = readdirSync(current, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        fullPath: path.join(current, entry.name),
      }));
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory) {
        stack.push(entry.fullPath);
        continue;
      }

      if (/\.html?$/i.test(entry.name)) {
        results.push(entry.fullPath);
        if (results.length >= MAX_DISCOVERED_HTML_FILES) break;
      }
    }
  }

  return results;
}

export function ensureTaskDeliverablesFromProjectDir(params: {
  taskId: string;
  taskTitle: string;
  projectDir?: string;
}): { existing: number; added: number; total: number } {
  const existingDeliverables = queryAll<{ path: string | null }>(
    'SELECT path FROM task_deliverables WHERE task_id = ?',
    [params.taskId],
  );
  if (existingDeliverables.length > 0) {
    return {
      existing: existingDeliverables.length,
      added: 0,
      total: existingDeliverables.length,
    };
  }

  const projectDir =
    params.projectDir ||
    path.join(getProjectsPath(), buildTaskProjectSlug(params.taskTitle || params.taskId));
  const resolvedProjectDir = expandHomePath(projectDir);

  if (!existsSync(resolvedProjectDir)) {
    return { existing: 0, added: 0, total: 0 };
  }

  const htmlFiles = discoverHtmlFiles(resolvedProjectDir);
  if (htmlFiles.length < 1) {
    return { existing: 0, added: 0, total: 0 };
  }

  const now = new Date().toISOString();
  let added = 0;
  for (const filePath of htmlFiles) {
    run(
      `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        params.taskId,
        'file',
        path.basename(filePath),
        filePath,
        'Auto-registered from task output directory',
        now,
      ],
    );
    added += 1;
  }

  return { existing: 0, added, total: added };
}

export function triggerAutomatedTaskTest(taskId: string): void {
  if (!taskId || inFlightAutoTests.has(taskId)) {
    return;
  }
  inFlightAutoTests.add(taskId);

  const missionControlUrl = getMissionControlUrl();
  void fetch(`${missionControlUrl}/api/tasks/${taskId}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
    .then(async (response) => {
      if (response.ok) return;
      let body = '';
      try {
        body = await response.text();
      } catch {
        body = '';
      }
      console.warn(
        `[auto-test] task ${taskId} returned HTTP ${response.status}${body ? `: ${body}` : ''}`,
      );
    })
    .catch((error) => {
      console.error(`[auto-test] failed for task ${taskId}:`, error);
    })
    .finally(() => {
      inFlightAutoTests.delete(taskId);
    });
}
