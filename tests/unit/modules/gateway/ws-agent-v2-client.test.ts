import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequest = vi.fn();
const mockConnect = vi.fn();
const mockOn = vi.fn(() => () => {});
const mockDisconnect = vi.fn();

vi.mock('@/modules/gateway/ws-client', () => {
  class MockGatewayClient {
    connect = mockConnect;
    disconnect = mockDisconnect;
    on = mockOn;
    request = mockRequest;
  }

  return {
    GatewayClient: MockGatewayClient,
  };
});

describe('AgentV2GatewayClient request retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('retries once after transient websocket disconnect errors', async () => {
    const { AgentV2GatewayClient } = await import('@/modules/gateway/ws-agent-v2-client');
    mockRequest
      .mockRejectedValueOnce(new Error('WebSocket not connected'))
      .mockResolvedValueOnce({ ok: true });

    const client = new AgentV2GatewayClient('ws://localhost:3000/ws-agent-v2');
    const result = await client.request('agent.v2.swarm.list', { limit: 1 });

    expect(result).toEqual({ ok: true });
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('does not retry on non-connection errors', async () => {
    const { AgentV2GatewayClient } = await import('@/modules/gateway/ws-agent-v2-client');
    mockRequest.mockRejectedValueOnce(new Error('Invalid swarm phase.'));

    const client = new AgentV2GatewayClient('ws://localhost:3000/ws-agent-v2');

    await expect(client.request('agent.v2.swarm.update', { id: 'swarm-1' })).rejects.toThrow(
      'Invalid swarm phase.',
    );
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});
