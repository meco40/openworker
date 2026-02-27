import { NextResponse } from 'next/server';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';
import { getMasterRepository } from '@/server/master/runtime';
import { executeToolForgePipeline } from '@/server/master/toolforge/pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ToolForgeBody {
  personaId?: string;
  workspaceId?: string;
  workspaceCwd?: string;
  name?: string;
  spec?: string;
  approved?: boolean;
  publishGlobally?: boolean;
}

export async function GET(request: Request) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const scope = resolveScopeFromRequest(request, userId);
    const artifacts = getMasterRepository().listToolForgeArtifacts(scope);
    return NextResponse.json({ ok: true, artifacts });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list toolforge artifacts';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = (await request.json()) as ToolForgeBody;
    if (!body.name || !body.spec) {
      return NextResponse.json({ ok: false, error: 'name and spec are required' }, { status: 400 });
    }
    const scope = resolveScopeFromRequest(request, userId, body);
    const artifact = executeToolForgePipeline(getMasterRepository(), scope, {
      name: body.name,
      spec: body.spec,
      approved: Boolean(body.approved),
      publishGlobally: Boolean(body.publishGlobally),
    });
    return NextResponse.json({ ok: true, artifact }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to run toolforge pipeline';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
