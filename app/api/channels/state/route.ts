import { NextResponse } from 'next/server';

import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';
import { LEGACY_LOCAL_USER_ID } from '../../../../src/server/auth/constants';
import { getMessageRepository } from '../../../../src/server/channels/messages/runtime';
import { isPersistentSessionV2Enabled } from '../../../../src/server/channels/messages/featureFlag';
import { CHANNEL_CAPABILITIES } from '../../../../src/server/channels/adapters/capabilities';
import type { ChannelKey } from '../../../../src/server/channels/adapters/types';

export const runtime = 'nodejs';

export async function GET() {
  let userId = LEGACY_LOCAL_USER_ID;

  if (isPersistentSessionV2Enabled()) {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    userId = userContext.userId;
  }

  const repo = getMessageRepository();
  const bindings = repo.listChannelBindings?.(userId) ?? [];
  const bindingMap = new Map(bindings.map((binding) => [binding.channel, binding]));

  const channels = Object.entries(CHANNEL_CAPABILITIES).map(([channel, capabilities]) => {
    const binding = bindingMap.get(channel as ChannelKey);
    return {
      channel,
      status: binding?.status ?? 'idle',
      externalPeerId: binding?.externalPeerId ?? null,
      peerName: binding?.peerName ?? null,
      transport: binding?.transport ?? null,
      lastSeenAt: binding?.lastSeenAt ?? null,
      ...capabilities,
    };
  });

  return NextResponse.json({
    ok: true,
    channels,
    generatedAt: new Date().toISOString(),
  });
}
