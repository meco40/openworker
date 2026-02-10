import type { ChannelType, Message } from '../../../../types';
import { toMessage } from './routeMessage';

export function createAgentPlaceholder(platform: ChannelType): Message {
  return toMessage('', platform, 'agent', {
    id: `msg-agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  });
}
