import { NextResponse } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const resolveRequestUserContextMock = vi.fn();

vi.mock('@/server/auth/userContext', () => ({
  resolveRequestUserContext: resolveRequestUserContextMock,
}));

describe('withUserContext', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 unauthorized when no user context is available', async () => {
    resolveRequestUserContextMock.mockResolvedValueOnce(null);

    const { withUserContext } = await import('../../../app/api/_shared/withUserContext');
    const wrapped = withUserContext(async () => NextResponse.json({ ok: true }));

    const response = await wrapped(new Request('http://localhost/api/test'));
    const payload = (await response.json()) as { ok: boolean; error?: string };

    expect(response.status).toBe(401);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('Unauthorized');
  });

  it('forwards request, params and user context to wrapped handler', async () => {
    resolveRequestUserContextMock.mockResolvedValueOnce({
      userId: 'user-123',
      authenticated: true,
    });

    const { withUserContext } = await import('../../../app/api/_shared/withUserContext');
    const wrapped = withUserContext<{ id: string }>(async ({ params, userContext }) =>
      NextResponse.json({
        ok: true,
        userId: userContext.userId,
        taskId: params.id,
      }),
    );

    const response = await wrapped(new Request('http://localhost/api/tasks/task-1'), {
      params: Promise.resolve({ id: 'task-1' }),
    });
    const payload = (await response.json()) as { ok: boolean; userId: string; taskId: string };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ ok: true, userId: 'user-123', taskId: 'task-1' });
  });
});
