import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { CreateWorkspaceSchema } from '@/lib/validation';
import type { TaskStatus, Workspace, WorkspaceStats } from '@/lib/types';
import { parseJsonBody } from '../_shared/parseJsonBody';
import { withUserContext } from '../_shared/withUserContext';

export const runtime = 'nodejs';

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export const GET = withUserContext(async ({ request }) => {
  const includeStats = new URL(request.url).searchParams.get('stats') === 'true';

  try {
    const db = getDb();

    if (!includeStats) {
      const workspaces = db.prepare('SELECT * FROM workspaces ORDER BY name').all();
      return NextResponse.json(workspaces);
    }

    const workspaces = db.prepare('SELECT * FROM workspaces ORDER BY name').all() as Workspace[];

    const stats: WorkspaceStats[] = workspaces.map((workspace) => {
      const taskCounts = db
        .prepare(
          `
            SELECT status, COUNT(*) as count
            FROM tasks
            WHERE workspace_id = ?
            GROUP BY status
          `,
        )
        .all(workspace.id) as { status: TaskStatus; count: number }[];

      const counts: WorkspaceStats['taskCounts'] = {
        pending_dispatch: 0,
        planning: 0,
        inbox: 0,
        assigned: 0,
        in_progress: 0,
        testing: 0,
        review: 0,
        done: 0,
        total: 0,
      };

      for (const taskCount of taskCounts) {
        counts[taskCount.status] = taskCount.count;
        counts.total += taskCount.count;
      }

      const agentCount = db
        .prepare('SELECT COUNT(*) as count FROM agents WHERE workspace_id = ?')
        .get(workspace.id) as { count: number };

      return {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        icon: workspace.icon,
        taskCounts: counts,
        agentCount: agentCount.count,
      };
    });

    return NextResponse.json(stats);
  } catch (error) {
    console.error('Failed to fetch workspaces:', error);
    return NextResponse.json({ error: 'Failed to fetch workspaces' }, { status: 500 });
  }
});

export const POST = withUserContext(async ({ request }) => {
  try {
    const parsed = await parseJsonBody(request, CreateWorkspaceSchema);
    if (!parsed.ok) {
      return parsed.response as Response;
    }

    const name = parsed.data.name.trim();
    const description = parsed.data.description?.trim() || null;
    const icon = parsed.data.icon?.trim() || '📁';
    const slug = generateSlug(name);
    const db = getDb();

    const existing = db.prepare('SELECT id FROM workspaces WHERE slug = ?').get(slug);
    if (existing) {
      return NextResponse.json(
        { error: 'A workspace with this name already exists' },
        { status: 400 },
      );
    }

    const id = crypto.randomUUID();
    db.prepare(
      `
      INSERT INTO workspaces (id, name, slug, description, icon)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run(id, name, slug, description, icon);

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    return NextResponse.json(workspace, { status: 201 });
  } catch (error) {
    console.error('Failed to create workspace:', error);
    return NextResponse.json({ error: 'Failed to create workspace' }, { status: 500 });
  }
});
