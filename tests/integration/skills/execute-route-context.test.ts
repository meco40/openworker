import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchSkillMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const normalizeSkillArgsMock = vi.hoisted(() => vi.fn((args: unknown) => (args || {}) as object));
const resolveRequestUserContextMock = vi.hoisted(() =>
  vi.fn(async () => ({ userId: 'legacy-user', authenticated: false })),
);

vi.mock('@/server/skills/executeSkill', () => ({
  dispatchSkill: dispatchSkillMock,
  normalizeSkillArgs: normalizeSkillArgsMock,
}));

vi.mock('@/server/auth/userContext', () => ({
  resolveRequestUserContext: resolveRequestUserContextMock,
}));

import { POST } from '../../../app/api/skills/execute/route';

describe('POST /api/skills/execute context forwarding', () => {
  beforeEach(() => {
    dispatchSkillMock.mockClear();
    normalizeSkillArgsMock.mockClear();
    resolveRequestUserContextMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards user and request context into dispatchSkill', async () => {
    const response = await POST(
      new Request('http://localhost/api/skills/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'subagents',
          args: { action: 'list' },
          context: {
            conversationId: 'conv-1',
            platform: 'webchat',
            externalChatId: 'default',
            workspaceCwd: 'D:\\web\\clawtest\\personas\\user\\projects\\demo',
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(dispatchSkillMock).toHaveBeenCalledTimes(1);
    expect(dispatchSkillMock).toHaveBeenCalledWith(
      'subagents',
      { action: 'list' },
      {
        userId: 'legacy-user',
        conversationId: 'conv-1',
        platform: 'webchat',
        externalChatId: 'default',
        workspaceCwd: 'D:\\web\\clawtest\\personas\\user\\projects\\demo',
      },
    );
  });
});
