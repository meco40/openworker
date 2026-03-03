import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { UpdateWorkspaceSchema } from '@/lib/validation';
import { parseJsonBody } from '../../_shared/parseJsonBody';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

export const GET = withUserContext<{ id: string }>(async ({ params }) => {
  const db = getDb();

  try {
    const workspace = db
      .prepare('SELECT * FROM workspaces WHERE id = ? OR slug = ?')
      .get(params.id, params.id);

    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    return NextResponse.json(workspace);
  } catch (error) {
    console.error('Failed to fetch workspace:', error);
    return NextResponse.json({ error: 'Failed to fetch workspace' }, { status: 500 });
  }
});

export const PATCH = withUserContext<{ id: string }>(async ({ request, params }) => {
  try {
    const parsed = await parseJsonBody(request, UpdateWorkspaceSchema);
    if (!parsed.ok) {
      return parsed.response as Response;
    }

    const body = parsed.data;
    const db = getDb();

    const existing = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(params.id);
    if (!existing) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name.trim());
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      values.push(body.description?.trim() || null);
    }
    if (body.icon !== undefined) {
      updates.push('icon = ?');
      values.push(body.icon.trim());
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    updates.push("updated_at = datetime('now')");
    values.push(params.id);

    db.prepare(`UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(params.id);
    return NextResponse.json(workspace);
  } catch (error) {
    console.error('Failed to update workspace:', error);
    return NextResponse.json({ error: 'Failed to update workspace' }, { status: 500 });
  }
});

export const DELETE = withUserContext<{ id: string }>(async ({ params }) => {
  try {
    const db = getDb();

    if (params.id === 'default') {
      return NextResponse.json({ error: 'Cannot delete the default workspace' }, { status: 400 });
    }

    const existing = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(params.id);
    if (!existing) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const taskCount = db
      .prepare('SELECT COUNT(*) as count FROM tasks WHERE workspace_id = ?')
      .get(params.id) as { count: number };
    const agentCount = db
      .prepare('SELECT COUNT(*) as count FROM agents WHERE workspace_id = ?')
      .get(params.id) as { count: number };

    if (taskCount.count > 0 || agentCount.count > 0) {
      return NextResponse.json(
        {
          error: 'Cannot delete workspace with existing tasks or agents',
          taskCount: taskCount.count,
          agentCount: agentCount.count,
        },
        { status: 400 },
      );
    }

    db.prepare('DELETE FROM workspaces WHERE id = ?').run(params.id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete workspace:', error);
    return NextResponse.json({ error: 'Failed to delete workspace' }, { status: 500 });
  }
});
