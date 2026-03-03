import { getDb } from '@/lib/db';
import type { Workspace } from '@/lib/types';
import WorkspaceClientPage from './WorkspaceClientPage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function WorkspacePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = getDb();

  const workspace =
    (db.prepare('SELECT * FROM workspaces WHERE id = ? OR slug = ?').get(slug, slug) as
      | Workspace
      | undefined) ?? null;

  return <WorkspaceClientPage slug={slug} initialWorkspace={workspace} />;
}
