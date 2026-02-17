import { NextResponse } from 'next/server';
import { getModelHubService } from '../../../../src/server/model-hub/runtime';
import type { PipelineReasoningEffort } from '../../../../src/server/model-hub/repository';
import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';

export const runtime = 'nodejs';

interface PipelineModelPayload {
  accountId: string;
  providerId: string;
  modelName: string;
  reasoningEffort?: PipelineReasoningEffort;
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
  reasoningEffort?: PipelineReasoningEffort;
  priority?: number;
}

interface RemoveModelBody {
  modelId?: string;
}

interface UpdateStatusBody {
  modelId?: string;
  status?: 'active' | 'rate-limited' | 'offline';
}

interface ReorderModelBody {
  profileId?: string;
  modelId?: string;
  direction?: 'up' | 'down';
}

const DEFAULT_PROFILE = 'p1';
const PIPELINE_REASONING_EFFORTS = new Set<PipelineReasoningEffort>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

function parseReasoningEffort(
  value: unknown,
): { ok: true; value: PipelineReasoningEffort | undefined } | { ok: false } {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return { ok: false };
  }
  const normalized = value.trim().toLowerCase();
  if (!PIPELINE_REASONING_EFFORTS.has(normalized as PipelineReasoningEffort)) {
    return { ok: false };
  }
  return { ok: true, value: normalized as PipelineReasoningEffort };
}

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

    const normalizedModels: Array<{
      accountId: string;
      providerId: string;
      modelName: string;
      reasoningEffort?: PipelineReasoningEffort;
      priority?: number;
    }> = [];

    for (const m of models) {
      if (!m.accountId || !m.providerId || !m.modelName) {
        return NextResponse.json(
          { ok: false, error: 'Each model needs accountId, providerId, modelName.' },
          { status: 400 },
        );
      }
      const reasoningEffort = parseReasoningEffort(m.reasoningEffort);
      if (!reasoningEffort.ok) {
        return NextResponse.json(
          {
            ok: false,
            error: 'reasoningEffort must be one of: off, minimal, low, medium, high, xhigh.',
          },
          { status: 400 },
        );
      }
      normalizedModels.push({
        accountId: m.accountId,
        providerId: m.providerId,
        modelName: m.modelName,
        reasoningEffort: reasoningEffort.value,
        priority: m.priority,
      });
    }

    const service = getModelHubService();
    const saved = service.replacePipeline(
      profileId,
      normalizedModels.map((m, idx) => ({
        profileId,
        accountId: m.accountId,
        providerId: m.providerId,
        modelName: m.modelName,
        reasoningEffort: m.reasoningEffort,
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

    const body = (await request.json()) as AddModelBody &
      RemoveModelBody &
      UpdateStatusBody & { action?: string };
    const action = body.action || 'add';

    const service = getModelHubService();

    if (action === 'add') {
      const profileId = body.profileId?.trim() || DEFAULT_PROFILE;
      const accountId = body.accountId?.trim();
      const providerId = body.providerId?.trim();
      const modelName = body.modelName?.trim();
      const priority = body.priority ?? 1;
      const reasoningEffort = parseReasoningEffort(body.reasoningEffort);

      if (!accountId || !providerId || !modelName) {
        return NextResponse.json(
          { ok: false, error: 'accountId, providerId, modelName are required.' },
          { status: 400 },
        );
      }
      if (!reasoningEffort.ok) {
        return NextResponse.json(
          {
            ok: false,
            error: 'reasoningEffort must be one of: off, minimal, low, medium, high, xhigh.',
          },
          { status: 400 },
        );
      }

      const entry = service.addModelToPipeline({
        profileId,
        accountId,
        providerId,
        modelName,
        reasoningEffort: reasoningEffort.value,
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

    if (action === 'reorder') {
      const reorderBody = body as ReorderModelBody;
      const profileId = reorderBody.profileId?.trim() || DEFAULT_PROFILE;
      const modelId = reorderBody.modelId?.trim();
      const direction = reorderBody.direction;
      if (!modelId || !direction) {
        return NextResponse.json(
          { ok: false, error: 'modelId and direction are required.' },
          { status: 400 },
        );
      }
      if (direction !== 'up' && direction !== 'down') {
        return NextResponse.json(
          { ok: false, error: 'direction must be "up" or "down".' },
          { status: 400 },
        );
      }
      const moved = service.movePipelineModel(profileId, modelId, direction);
      return NextResponse.json({ ok: true, moved });
    }

    return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Pipeline operation failed.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
