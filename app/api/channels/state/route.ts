import { NextResponse } from 'next/server';

import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';
import { getMessageRepository } from '../../../../src/server/channels/messages/runtime';
import { CHANNEL_CAPABILITIES } from '../../../../src/server/channels/adapters/capabilities';
import type { ChannelKey } from '../../../../src/server/channels/adapters/types';
import { listBridgeAccounts } from '../../../../src/server/channels/pairing/bridgeAccounts';

export const runtime = 'nodejs';

export async function GET() {
  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const userId = userContext.userId;

  const repo = getMessageRepository();
  const bindings = repo.listChannelBindings?.(userId) ?? [];
  const bindingMap = new Map(bindings.map((binding) => [binding.channel, binding]));

  const channels = Object.entries(CHANNEL_CAPABILITIES).map(([channel, capabilities]) => {
    const binding = bindingMap.get(channel as ChannelKey);
    const bridgeAccounts =
      channel === 'whatsapp' || channel === 'imessage'
        ? listBridgeAccounts(channel)
        : undefined;
    return {
      channel,
      status: binding?.status ?? 'idle',
      externalPeerId: binding?.externalPeerId ?? null,
      peerName: binding?.peerName ?? null,
      transport: binding?.transport ?? null,
      lastSeenAt: binding?.lastSeenAt ?? null,
      accounts: bridgeAccounts,
      ...capabilities,
    };
  });

  return NextResponse.json({
    ok: true,
    channels,
    generatedAt: new Date().toISOString(),
  });
}
