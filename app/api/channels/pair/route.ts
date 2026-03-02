import { NextResponse } from 'next/server';
import { isPairChannelType, pairChannel, unpairChannel } from '@/server/channels/pairing';
import { getMessageRepository } from '@/server/channels/messages/runtime';
import { withResolvedUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

interface PairRequest {
  channel?: string;
  token?: string;
  accountId?: string;
}

export const POST = withResolvedUserContext(async ({ request, userContext }) => {
  try {
    const body = (await request.json()) as PairRequest;
    if (!body.channel) {
      return NextResponse.json({ ok: false, error: 'channel is required' }, { status: 400 });
    }
    if (!isPairChannelType(body.channel)) {
      return NextResponse.json({ ok: false, error: 'Unsupported channel' }, { status: 400 });
    }

    const validated = await pairChannel(body.channel, body.token || '', body.accountId);
    const status =
      typeof validated === 'object' &&
      validated !== null &&
      'status' in validated &&
      typeof (validated as { status?: unknown }).status === 'string'
        ? ((validated as { status: string }).status as string)
        : 'connected';
    const transport =
      typeof validated === 'object' &&
      validated !== null &&
      'transport' in validated &&
      typeof (validated as { transport?: unknown }).transport === 'string'
        ? ((validated as { transport: string }).transport as string)
        : undefined;

    const resolvedAccountId =
      typeof validated === 'object' &&
      validated !== null &&
      'accountId' in validated &&
      typeof (validated as { accountId?: unknown }).accountId === 'string'
        ? ((validated as { accountId: string }).accountId as string)
        : body.accountId || 'default';

    const connectedAt = new Date().toISOString();

    // Persist binding so /api/channels/state reflects the real status on refresh
    if (userContext) {
      const repo = getMessageRepository();
      repo.upsertChannelBinding?.({
        userId: userContext.userId,
        channel: body.channel,
        status: status === 'awaiting_code' ? 'awaiting_code' : 'connected',
        peerName: validated.peerName,
        transport,
        metadata:
          resolvedAccountId && resolvedAccountId !== 'default'
            ? { accountId: resolvedAccountId }
            : undefined,
      });
    }

    return NextResponse.json({
      ok: true,
      status,
      transport,
      peerName: validated.peerName,
      connectedAt,
      details: validated.details,
      accountId: resolvedAccountId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown channel pairing error';
    const status = message.startsWith('Unsupported channel:') ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
});

interface UnpairRequest {
  channel?: string;
  accountId?: string;
}

export const DELETE = withResolvedUserContext(async ({ request, userContext }) => {
  try {
    const body = (await request.json()) as UnpairRequest;
    if (!body.channel) {
      return NextResponse.json({ ok: false, error: 'channel is required' }, { status: 400 });
    }
    if (!isPairChannelType(body.channel)) {
      return NextResponse.json({ ok: false, error: 'Unsupported channel' }, { status: 400 });
    }

    await unpairChannel(body.channel, body.accountId);

    // Clear binding in the DB so state route reflects 'idle' on refresh
    if (userContext) {
      const repo = getMessageRepository();
      repo.upsertChannelBinding?.({
        userId: userContext.userId,
        channel: body.channel,
        status: 'disconnected',
        metadata: body.accountId ? { accountId: body.accountId } : undefined,
      });
    }

    return NextResponse.json({
      ok: true,
      status: 'disconnected',
      channel: body.channel,
      accountId: body.accountId || 'default',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown channel unpair error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});
