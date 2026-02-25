import { describe, expect, it } from 'vitest';
import {
  buildPhaseIdempotencyKey,
  getPhaseCommandMethod,
  isTransientGatewayConnectionError,
  isRateLimitedGatewayError,
  shouldFallbackToSessionSnapshot,
} from '@/modules/agent-room/hooks/useAgentRoomRuntime';

describe('useAgentRoomRuntime contract helpers', () => {
  it('builds deterministic idempotency keys per swarm phase', () => {
    expect(buildPhaseIdempotencyKey('swarm-1', 'analysis')).toBe('swarm-1:analysis');
    expect(buildPhaseIdempotencyKey('swarm-1', 'result')).toBe('swarm-1:result');
  });

  it('maps analysis to session.input and later phases to follow_up', () => {
    expect(getPhaseCommandMethod('analysis')).toBe('agent.v2.session.input');
    expect(getPhaseCommandMethod('ideation')).toBe('agent.v2.session.follow_up');
    expect(getPhaseCommandMethod('result')).toBe('agent.v2.session.follow_up');
  });

  it('detects replay-expiry errors for snapshot fallback', () => {
    expect(shouldFallbackToSessionSnapshot(new Error('Replay window expired'))).toBe(true);
    expect(shouldFallbackToSessionSnapshot(new Error('REPLAY_WINDOW_EXPIRED'))).toBe(true);
    expect(shouldFallbackToSessionSnapshot(new Error('other error'))).toBe(false);
  });

  it('detects gateway rate-limit errors by code or message', () => {
    const withCode = Object.assign(new Error('ignored'), { code: 'RATE_LIMITED' });
    expect(isRateLimitedGatewayError(withCode)).toBe(true);
    expect(isRateLimitedGatewayError(new Error('Too many requests'))).toBe(true);
    expect(isRateLimitedGatewayError(new Error('another error'))).toBe(false);
  });

  it('detects transient websocket connection errors', () => {
    expect(isTransientGatewayConnectionError(new Error('WebSocket not connected'))).toBe(true);
    expect(isTransientGatewayConnectionError(new Error('Client disconnected'))).toBe(true);
    expect(isTransientGatewayConnectionError(new Error('Failed to connect'))).toBe(true);
    expect(isTransientGatewayConnectionError(new Error('unexpected error'))).toBe(false);
  });
});
