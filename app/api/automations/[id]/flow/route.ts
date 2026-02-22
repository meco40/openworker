import { NextResponse } from 'next/server';

import { getAutomationService } from '@/server/automation/runtime';
import { resolveAutomationUserId } from '@/server/automation/httpAuth';
import { validateFlowGraph } from '@/server/automation/flowValidator';
import { compileFlow } from '@/server/automation/flowCompiler';
import type { FlowGraph } from '@/server/automation/flowTypes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FLOW_GRAPH_BYTES = 500 * 1024; // 500 KB

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, ctx: RouteContext) {
  const userId = await resolveAutomationUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;
  const service = getAutomationService();
  const flowGraph = service.getFlowGraph(id, userId);
  return NextResponse.json({ ok: true, flowGraph: flowGraph ?? null });
}

export async function PUT(req: Request, ctx: RouteContext) {
  const userId = await resolveAutomationUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  // Size check before parsing (relies on Content-Length header)
  const contentLength = Number(req.headers.get('content-length') ?? 0);
  if (contentLength > MAX_FLOW_GRAPH_BYTES) {
    return NextResponse.json(
      { ok: false, error: 'Payload too large (max 500 KB)' },
      { status: 413 },
    );
  }

  const { id } = await ctx.params;

  // Safe JSON parse
  let body: { flowGraph?: FlowGraph };
  try {
    body = (await req.json()) as { flowGraph?: FlowGraph };
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.flowGraph || typeof body.flowGraph !== 'object') {
    return NextResponse.json({ ok: false, error: 'flowGraph is required' }, { status: 400 });
  }

  const validation = validateFlowGraph(body.flowGraph);
  if (!validation.valid) {
    return NextResponse.json({ ok: false, errors: validation.errors }, { status: 422 });
  }

  const compiled = compileFlow(body.flowGraph);
  const service = getAutomationService();
  const updated = service.saveFlowGraph(id, userId, body.flowGraph, compiled);

  if (!updated) {
    return NextResponse.json({ ok: false, error: 'Automation rule not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, rule: updated });
}
