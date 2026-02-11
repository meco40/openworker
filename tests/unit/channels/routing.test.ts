import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerAdapter,
  resetAdapterRegistryForTests,
} from '../../../src/server/channels/routing/adapterRegistry';
import { routeOutbound } from '../../../src/server/channels/routing/outboundRouter';
import { routeInbound } from '../../../src/server/channels/routing/inboundRouter';

describe('channel routing', () => {
  beforeEach(() => {
    resetAdapterRegistryForTests();
  });

  it('routes outbound delivery through registered adapter', async () => {
    const send = vi.fn(async () => {});
    registerAdapter({ channel: 'telegram', send });

    const routed = await routeOutbound({
      channel: 'telegram',
      externalChatId: 'chat-1',
      content: 'hello',
    });

    expect(routed).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });

  it('returns false when outbound adapter is missing', async () => {
    const routed = await routeOutbound({
      channel: 'slack',
      externalChatId: 'c1',
      content: 'test',
    });
    expect(routed).toBe(false);
  });

  it('calls fallback inbound handler when adapter receive is missing', async () => {
    const fallback = vi.fn(async () => {});
    const routed = await routeInbound(
      {
        channel: 'discord',
        externalChatId: 'c1',
        externalMessageId: 'm1',
        senderName: 'max',
        content: 'hi',
        receivedAt: new Date().toISOString(),
        raw: {},
      },
      fallback,
    );

    expect(routed).toBe(true);
    expect(fallback).toHaveBeenCalledOnce();
  });
});
