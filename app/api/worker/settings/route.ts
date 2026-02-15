import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';
import { getWorkerRepository } from '../../../../src/server/worker/workerRepository';
import { getDefaultWorkspacesRoot } from '../../../../src/server/worker/workspaceManager';

export const runtime = 'nodejs';

function toSettingsPayload(settings: { defaultWorkspaceRoot: string | null } | null) {
  const defaultWorkspaceRoot = settings?.defaultWorkspaceRoot || null;
  const currentWorkspaceRoot = defaultWorkspaceRoot || getDefaultWorkspacesRoot();
  const workspaceRootSource = defaultWorkspaceRoot ? 'user_setting' : 'system_default';
  return {
    defaultWorkspaceRoot,
    currentWorkspaceRoot,
    workspaceRootSource,
  } as const;
}

function normalizeWorkspaceRoot(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: 'defaultWorkspaceRoot must be a string or null.' };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, value: null };
  }
  if (!path.isAbsolute(trimmed)) {
    return { ok: false, error: 'defaultWorkspaceRoot must be an absolute path.' };
  }

  return { ok: true, value: path.resolve(trimmed) };
}

export async function GET() {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const repo = getWorkerRepository();
    const settings = repo.getUserSettings(userContext.userId);

    return NextResponse.json({
      ok: true,
      settings: { ...toSettingsPayload(settings), updatedAt: settings?.updatedAt || null },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load worker settings';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as { defaultWorkspaceRoot?: unknown };
    const normalized = normalizeWorkspaceRoot(body.defaultWorkspaceRoot);
    if (!normalized.ok) {
      return NextResponse.json({ ok: false, error: normalized.error }, { status: 400 });
    }

    if (normalized.value) {
      try {
        fs.mkdirSync(normalized.value, { recursive: true });
      } catch {
        return NextResponse.json(
          { ok: false, error: 'defaultWorkspaceRoot cannot be created or accessed.' },
          { status: 400 },
        );
      }
    }

    const repo = getWorkerRepository();
    const saved = repo.saveUserSettings(userContext.userId, {
      defaultWorkspaceRoot: normalized.value,
    });

    return NextResponse.json({
      ok: true,
      settings: { ...toSettingsPayload(saved), updatedAt: saved.updatedAt },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save worker settings';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
