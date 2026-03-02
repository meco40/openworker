import { NextResponse } from 'next/server';
import {
  listBridgeAccounts,
  normalizeBridgeAccountId,
  upsertBridgeAccount,
  writeBridgeAccountAllowFrom,
} from '@/server/channels/pairing/bridgeAccounts';
import { withUserContext } from '../../../_shared/withUserContext';

export const runtime = 'nodejs';

function parseAllowFromInput(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || ''));
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

export const GET = withUserContext(async () => {
  return NextResponse.json({
    ok: true,
    accounts: listBridgeAccounts('whatsapp'),
    generatedAt: new Date().toISOString(),
  });
});

export const PUT = withUserContext(async ({ request }) => {
  try {
    const body = (await request.json()) as {
      accountId?: string;
      allowFrom?: string[] | string;
    };
    const accountId = normalizeBridgeAccountId(body.accountId);
    upsertBridgeAccount('whatsapp', { accountId });

    const normalizedAllowFrom = writeBridgeAccountAllowFrom(
      'whatsapp',
      accountId,
      parseAllowFromInput(body.allowFrom),
    );
    const account = listBridgeAccounts('whatsapp').find((entry) => entry.accountId === accountId);

    return NextResponse.json({
      ok: true,
      accountId,
      allowFrom: normalizedAllowFrom,
      account: account || null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request.';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
});
