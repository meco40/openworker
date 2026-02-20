import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '@/server/auth/userContext';
import {
  GatewayConfigConflictError,
  GatewayConfigValidationError,
  loadGatewayConfig,
  redactGatewayConfigSecrets,
  saveGatewayConfig,
  toGatewayConfigDisplayPath,
} from '@/server/config/gatewayConfig';
import {
  logConfigLoadFailed,
  logConfigLoadSuccess,
  logConfigSaveAttempt,
  logConfigSaveFailed,
  logConfigSaveSuccess,
} from '@/server/telemetry/configEvents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ErrorPayload {
  ok: false;
  error: string;
  code?: string;
  currentRevision?: string;
}

interface PutBody {
  config?: unknown;
  revision?: string;
}

function isObjectBody(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

function toSafeErrorPayload(
  error: unknown,
  fallbackMessage: string,
): { status: number; payload: ErrorPayload } {
  if (error instanceof GatewayConfigConflictError) {
    return {
      status: 409,
      payload: {
        ok: false,
        error: 'Config was changed by another session. Reload and review your changes.',
        code: 'CONFIG_STALE_REVISION',
        currentRevision: error.currentRevision,
      },
    };
  }

  if (error instanceof GatewayConfigValidationError || error instanceof SyntaxError) {
    return {
      status: 400,
      payload: {
        ok: false,
        error: error.message,
        code: 'CONFIG_VALIDATION_ERROR',
      },
    };
  }

  return {
    status: 500,
    payload: {
      ok: false,
      error: fallbackMessage,
      code: 'CONFIG_INTERNAL_ERROR',
    },
  };
}

export async function GET() {
  let userId = 'unknown';
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    userId = userContext.userId;
    const loaded = await loadGatewayConfig();
    logConfigLoadSuccess({
      userId,
      source: loaded.source,
      warningCount: loaded.warnings.length,
      revision: loaded.revision,
      status: 200,
    });

    return NextResponse.json({
      ok: true,
      config: redactGatewayConfigSecrets(loaded.config),
      source: loaded.source,
      displayPath: toGatewayConfigDisplayPath(loaded.path),
      warnings: loaded.warnings,
      revision: loaded.revision,
    });
  } catch (error) {
    const safe = toSafeErrorPayload(error, 'Unable to load config.');
    logConfigLoadFailed({ userId, status: safe.status, reason: safe.payload.code });
    return NextResponse.json(safe.payload, { status: safe.status });
  }
}

export async function PUT(request: Request) {
  let userId = 'unknown';
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    userId = userContext.userId;

    let rawBody: unknown;
    try {
      rawBody = (await request.json()) as unknown;
    } catch {
      return NextResponse.json(
        {
          ok: false,
          error: 'Invalid JSON body. Expected object.',
          code: 'CONFIG_VALIDATION_ERROR',
        },
        { status: 400 },
      );
    }

    if (!isObjectBody(rawBody)) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Invalid JSON body. Expected object.',
          code: 'CONFIG_VALIDATION_ERROR',
        },
        { status: 400 },
      );
    }

    const body = rawBody as PutBody;
    if (!Object.prototype.hasOwnProperty.call(rawBody, 'config')) {
      return NextResponse.json(
        { ok: false, error: 'config is required.', code: 'CONFIG_VALIDATION_ERROR' },
        { status: 400 },
      );
    }

    const revision = String(body.revision || '').trim();
    if (!revision) {
      return NextResponse.json(
        {
          ok: false,
          error: 'config.revision is required to prevent stale writes.',
          code: 'CONFIG_STALE_REVISION',
        },
        { status: 409 },
      );
    }

    logConfigSaveAttempt({ userId, status: 200, revision });
    const saved = await saveGatewayConfig(body.config, { expectedRevision: revision });
    logConfigSaveSuccess({
      userId,
      source: saved.source,
      warningCount: saved.warnings.length,
      revision: saved.revision,
      status: 200,
    });

    return NextResponse.json({
      ok: true,
      config: redactGatewayConfigSecrets(saved.config),
      source: saved.source,
      displayPath: toGatewayConfigDisplayPath(saved.path),
      warnings: saved.warnings,
      revision: saved.revision,
    });
  } catch (error) {
    const safe = toSafeErrorPayload(error, 'Unable to save config.');
    logConfigSaveFailed({ userId, status: safe.status, reason: safe.payload.code });
    return NextResponse.json(safe.payload, { status: safe.status });
  }
}
