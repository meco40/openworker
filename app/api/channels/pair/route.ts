import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

interface PairRequest {
  channel: 'whatsapp' | 'telegram' | 'discord' | 'imessage';
  token?: string;
}

async function validateTelegram(token: string) {
  if (!token) throw new Error('Telegram token is required.');
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const data = await response.json();
  if (!response.ok || !data?.ok) {
    throw new Error(`Telegram auth failed: ${JSON.stringify(data)}`);
  }
  return {
    peerName: data.result?.username || `telegram:${data.result?.id || 'unknown'}`,
    details: data.result,
  };
}

async function validateDiscord(token: string) {
  if (!token) throw new Error('Discord bot token is required.');
  const response = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${token}` },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Discord auth failed: ${JSON.stringify(data)}`);
  }
  return {
    peerName: data.username ? `${data.username}#${data.discriminator || '0'}` : 'discord-bot',
    details: data,
  };
}

async function validateExternalBridge(channel: 'whatsapp' | 'imessage') {
  const envName = channel === 'whatsapp' ? 'WHATSAPP_BRIDGE_URL' : 'IMESSAGE_BRIDGE_URL';
  const bridgeUrl = process.env[envName];
  if (!bridgeUrl) {
    throw new Error(`${envName} is not configured.`);
  }

  const healthUrl = `${bridgeUrl.replace(/\/$/, '')}/health`;
  const response = await fetch(healthUrl);
  if (!response.ok) {
    throw new Error(`${channel} bridge health check failed with ${response.status}.`);
  }
  const data = await response.json().catch(() => ({}));
  return {
    peerName: data?.peerName || `${channel}-bridge`,
    details: data,
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as PairRequest;
    if (!body?.channel) {
      return NextResponse.json({ ok: false, error: 'channel is required' }, { status: 400 });
    }

    let validated: { peerName: string; details: unknown };
    if (body.channel === 'telegram') {
      validated = await validateTelegram(body.token || '');
    } else if (body.channel === 'discord') {
      validated = await validateDiscord(body.token || '');
    } else if (body.channel === 'whatsapp' || body.channel === 'imessage') {
      validated = await validateExternalBridge(body.channel);
    } else {
      return NextResponse.json({ ok: false, error: 'Unsupported channel' }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      status: 'connected',
      peerName: validated.peerName,
      connectedAt: new Date().toISOString(),
      details: validated.details,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown channel pairing error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
