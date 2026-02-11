import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleInbound = vi.fn(async () => ({
  userMsg: { id: 'u1' },
  agentMsg: { id: 'a1' },
}));

vi.mock('../../../src/server/channels/messages/runtime', () => ({
  getMessageService: () => ({
    handleInbound,
  }),
}));

function makeRequest(body: unknown, secret = 'test-secret'): Request {
  return new Request('http://localhost/api/channels/slack/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-secret': secret,
    },
    body: JSON.stringify(body),
  });
}

describe('slack webhook route', () => {
  beforeEach(() => {
    handleInbound.mockClear();
    process.env.SLACK_WEBHOOK_SECRET = 'test-secret';
  });

  it('routes inbound slack messages into message service', async () => {
    const { POST } = await import('../../../app/api/channels/slack/webhook/route');
    const response = await POST(
      makeRequest({
        type: 'event_callback',
        event: {
          type: 'message',
          text: 'hello from slack',
          channel: 'C123',
          user: 'U777',
          ts: '1700000.01',
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(handleInbound).toHaveBeenCalledWith('Slack', 'C123', 'hello from slack', 'U777', '1700000.01');
  });

  it('responds to url_verification challenge', async () => {
    const { POST } = await import('../../../app/api/channels/slack/webhook/route');
    const response = await POST(
      makeRequest({
        type: 'url_verification',
        challenge: 'abc123',
      }),
    );
    const json = (await response.json()) as { challenge: string };

    expect(response.status).toBe(200);
    expect(json.challenge).toBe('abc123');
    expect(handleInbound).not.toHaveBeenCalled();
  });
});
