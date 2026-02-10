import { NextResponse } from 'next/server';
import { getModelHubEncryptionKey, getModelHubService } from '../../../../src/server/model-hub/runtime';
import type { GatewayMessage } from '../../../../src/server/model-hub/gateway';

export const runtime = 'nodejs';

interface GatewayRequestBody {
  /** Explicit accountId + model for direct dispatch */
  accountId?: string;
  model?: string;
  /** Or use pipeline fallback (profileId-based) */
  profileId?: string;
  messages: GatewayMessage[];
  max_tokens?: number;
  temperature?: number;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as GatewayRequestBody;

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'messages array is required and must not be empty.' },
        { status: 400 },
      );
    }

    const service = getModelHubService();
    const encryptionKey = getModelHubEncryptionKey();

    // Direct dispatch with accountId + model
    if (body.accountId && body.model) {
      const result = await service.dispatchChat(body.accountId, encryptionKey, {
        model: body.model,
        messages: body.messages,
        max_tokens: body.max_tokens,
        temperature: body.temperature,
      });
      return NextResponse.json(result, { status: result.ok ? 200 : 502 });
    }

    // Pipeline fallback dispatch
    const profileId = body.profileId?.trim() || 'p1';
    const result = await service.dispatchWithFallback(profileId, encryptionKey, {
      messages: body.messages,
      max_tokens: body.max_tokens,
      temperature: body.temperature,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Gateway dispatch failed.';
    return NextResponse.json(
      { ok: false, text: '', model: '', provider: '', error: message },
      { status: 500 },
    );
  }
}
