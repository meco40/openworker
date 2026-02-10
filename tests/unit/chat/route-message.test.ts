import { describe, expect, it } from 'vitest';
import { toMessage } from '../../../src/modules/chat/services/routeMessage';
import { ChannelType } from '../../../types';

describe('routeMessage', () => {
  it('creates a user message payload', () => {
    const msg = toMessage('hello', ChannelType.WEBCHAT, 'user');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('hello');
  });
});
