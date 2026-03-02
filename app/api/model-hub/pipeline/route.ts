import { NextResponse } from 'next/server';
import { getModelHubService } from '@/server/model-hub/runtime';
import type { PipelineReasoningEffort } from '@/server/model-hub/repository';
import {
  syncMem0EmbedderFromModelHub,
  syncMem0LlmFromModelHub,
} from '@/server/memory/mem0EmbedderSync';
import { resolveRequestUserContext } from '@/server/auth/userContext';

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
const EMBEDDING_PROFILE_ID = 'p1-embeddings';
const PIPELINE_REASONING_EFFORTS = new Set<PipelineReasoningEffort>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

type Mem0LlmSyncResult = Awaited<ReturnType<typeof syncMem0LlmFromModelHub>>;
type Mem0EmbedderSyncResult = Awaited<ReturnType<typeof syncMem0EmbedderFromModelHub>>;

async function runMem0Syncs(input: { syncLlm: boolean; syncEmbedder: boolean }): Promise<{
  mem0LlmSync: Mem0LlmSyncResult | undefined;
  mem0EmbedderSync: Mem0EmbedderSyncResult | undefined;
}> {
  const llmSyncPromise = input.syncLlm
    ? syncMem0LlmFromModelHub()
    : Promise.resolve(undefined as Mem0LlmSyncResult | undefined);
  const embedderSyncPromise = input.syncEmbedder
    ? syncMem0EmbedderFromModelHub()
    : Promise.resolve(undefined as Mem0EmbedderSyncResult | undefined);

  const [mem0LlmSync, mem0EmbedderSync] = await Promise.all([llmSyncPromise, embedderSyncPromise]);
  return { mem0LlmSync, mem0EmbedderSync };
}

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
    const { mem0LlmSync, mem0EmbedderSync } = await runMem0Syncs({
      syncLlm: profileId === DEFAULT_PROFILE,
      syncEmbedder: profileId === EMBEDDING_PROFILE_ID,
    });

    return NextResponse.json({ ok: true, profileId, models: saved, mem0LlmSync, mem0EmbedderSync });
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
      const { mem0LlmSync, mem0EmbedderSync } = await runMem0Syncs({
        syncLlm: profileId === DEFAULT_PROFILE,
        syncEmbedder: profileId === EMBEDDING_PROFILE_ID,
      });
      return NextResponse.json({ ok: true, model: entry, mem0LlmSync, mem0EmbedderSync });
    }

    if (action === 'remove') {
      const modelId = body.modelId?.trim();
      if (!modelId) {
        return NextResponse.json({ ok: false, error: 'modelId is required.' }, { status: 400 });
      }
      const shouldSyncMem0Llm = service
        .listPipeline(DEFAULT_PROFILE)
        .some((model) => model.id === modelId);
      const shouldSyncMem0Embedder = service
        .listPipeline(EMBEDDING_PROFILE_ID)
        .some((model) => model.id === modelId);
      const removed = service.removeModelFromPipeline(modelId);
      const { mem0LlmSync, mem0EmbedderSync } = await runMem0Syncs({
        syncLlm: shouldSyncMem0Llm,
        syncEmbedder: shouldSyncMem0Embedder,
      });
      return NextResponse.json({ ok: true, removed, mem0LlmSync, mem0EmbedderSync });
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
      const shouldSyncMem0Llm = service
        .listPipeline(DEFAULT_PROFILE)
        .some((model) => model.id === modelId);
      const shouldSyncMem0Embedder = service
        .listPipeline(EMBEDDING_PROFILE_ID)
        .some((model) => model.id === modelId);
      service.updateModelStatus(modelId, status);
      const { mem0LlmSync, mem0EmbedderSync } = await runMem0Syncs({
        syncLlm: shouldSyncMem0Llm,
        syncEmbedder: shouldSyncMem0Embedder,
      });
      return NextResponse.json({ ok: true, mem0LlmSync, mem0EmbedderSync });
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
      const { mem0LlmSync, mem0EmbedderSync } = await runMem0Syncs({
        syncLlm: profileId === DEFAULT_PROFILE,
        syncEmbedder: profileId === EMBEDDING_PROFILE_ID,
      });
      return NextResponse.json({ ok: true, moved, mem0LlmSync, mem0EmbedderSync });
    }

    return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Pipeline operation failed.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
