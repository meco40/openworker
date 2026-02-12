import { NextResponse } from 'next/server';
import { getModelHubService } from '../../../../src/server/model-hub/runtime';
import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';

export const runtime = 'nodejs';

interface PipelineModelPayload {
  accountId: string;
  providerId: string;
  modelName: string;
  priority: number;
}

interface SavePipelineBody {
  profileId?: string;
  models?: PipelineModelPayload[];
}

interface AddModelBody {
  profileId?: string;
  accountId?: string;
  providerId?: string;
  modelName?: string;
  priority?: number;
}

interface RemoveModelBody {
  modelId?: string;
}

interface UpdateStatusBody {
  modelId?: string;
  status?: 'active' | 'rate-limited' | 'offline';
}

const DEFAULT_PROFILE = 'p1';

export async function GET(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(request.url);
    const profileId = url.searchParams.get('profileId')?.trim() || DEFAULT_PROFILE;

    const service = getModelHubService();
    const models = service.listPipeline(profileId);

    return NextResponse.json({ ok: true, profileId, models });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to list pipeline.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as SavePipelineBody;
    const profileId = body.profileId?.trim() || DEFAULT_PROFILE;
    const models = body.models;

    if (!Array.isArray(models)) {
      return NextResponse.json({ ok: false, error: 'models array is required.' }, { status: 400 });
    }

    for (const m of models) {
      if (!m.accountId || !m.providerId || !m.modelName) {
        return NextResponse.json(
          { ok: false, error: 'Each model needs accountId, providerId, modelName.' },
          { status: 400 },
        );
      }
    }

    const service = getModelHubService();
    const saved = service.replacePipeline(
      profileId,
      models.map((m, idx) => ({
        profileId,
        accountId: m.accountId,
        providerId: m.providerId,
        modelName: m.modelName,
        priority: m.priority ?? idx + 1,
      })),
    );

    return NextResponse.json({ ok: true, profileId, models: saved });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to save pipeline.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as AddModelBody & RemoveModelBody & UpdateStatusBody & { action?: string };
    const action = body.action || 'add';

    const service = getModelHubService();

    if (action === 'add') {
      const profileId = body.profileId?.trim() || DEFAULT_PROFILE;
      const accountId = body.accountId?.trim();
      const providerId = body.providerId?.trim();
      const modelName = body.modelName?.trim();
      const priority = body.priority ?? 1;

      if (!accountId || !providerId || !modelName) {
        return NextResponse.json(
          { ok: false, error: 'accountId, providerId, modelName are required.' },
          { status: 400 },
        );
      }

      const entry = service.addModelToPipeline({
        profileId,
        accountId,
        providerId,
        modelName,
        priority,
      });
      return NextResponse.json({ ok: true, model: entry });
    }

    if (action === 'remove') {
      const modelId = body.modelId?.trim();
      if (!modelId) {
        return NextResponse.json({ ok: false, error: 'modelId is required.' }, { status: 400 });
      }
      const removed = service.removeModelFromPipeline(modelId);
      return NextResponse.json({ ok: true, removed });
    }

    if (action === 'status') {
      const modelId = body.modelId?.trim();
      const status = body.status;
      if (!modelId || !status) {
        return NextResponse.json(
          { ok: false, error: 'modelId and status are required.' },
          { status: 400 },
        );
      }
      service.updateModelStatus(modelId, status);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Pipeline operation failed.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
