import { NextRequest } from 'next/server';
import { getTaskTestInfo, runTaskTests } from '@/server/tasks/testing';

interface TaskIdParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/tasks/[id]/test
 * Route adapter for automated deliverable tests.
 */
export async function POST(_request: NextRequest, { params }: TaskIdParams) {
  const { id: taskId } = await params;
  return runTaskTests(taskId);
}

/**
 * GET /api/tasks/[id]/test
 * Route adapter for test endpoint info.
 */
export async function GET(_request: NextRequest, { params }: TaskIdParams) {
  const { id: taskId } = await params;
  return getTaskTestInfo(taskId);
}
