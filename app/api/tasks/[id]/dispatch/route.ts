import { NextResponse, type NextRequest } from 'next/server';
import { dispatchTask } from '@/server/tasks/dispatch';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/tasks/[id]/dispatch
 *
 * Thin route adapter: delegates orchestration to server task dispatch use-cases.
 */
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const result = await dispatchTask(id);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error('Failed to dispatch task:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
