import { NextResponse } from 'next/server';
import {
  isPairChannelType,
  pairChannel,
  unpairChannel,
} from '../../../../src/server/channels/pairing';

export const runtime = 'nodejs';

interface PairRequest {
  channel?: string;
  token?: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as PairRequest;
    if (!body.channel) {
      return NextResponse.json({ ok: false, error: 'channel is required' }, { status: 400 });
    }
    if (!isPairChannelType(body.channel)) {
      return NextResponse.json({ ok: false, error: 'Unsupported channel' }, { status: 400 });
    }

    const validated = await pairChannel(body.channel, body.token || '');
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

    return NextResponse.json({
      ok: true,
      status,
      transport,
      peerName: validated.peerName,
      connectedAt: new Date().toISOString(),
      details: validated.details,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown channel pairing error';
    const status = message.startsWith('Unsupported channel:') ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

interface UnpairRequest {
  channel?: string;
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as UnpairRequest;
    if (!body.channel) {
      return NextResponse.json({ ok: false, error: 'channel is required' }, { status: 400 });
    }
    if (!isPairChannelType(body.channel)) {
      return NextResponse.json({ ok: false, error: 'Unsupported channel' }, { status: 400 });
    }

    await unpairChannel(body.channel);

    return NextResponse.json({
      ok: true,
      status: 'disconnected',
      channel: body.channel,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown channel unpair error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
