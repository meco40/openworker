import { NextResponse } from 'next/server';
import { isPairChannelType, pairChannel } from '../../../../src/server/channels/pairing';

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

    return NextResponse.json({
      ok: true,
      status: 'connected',
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
