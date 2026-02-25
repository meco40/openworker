import { NextResponse } from 'next/server';
import { getModelHubService } from '@/server/model-hub/runtime';
import { PROVIDER_CATALOG } from '@/server/model-hub/providerCatalog';

export const runtime = 'nodejs';

const DEFAULT_PROFILE_ID = 'p1';

interface ModelInfoResponse {
  defaultModel: string | undefined;
  availableModels: string[];
}

interface OpenClawModelsResponse {
  defaultModel?: string;
  availableModels: string[];
  error?: string;
}

/**
 * GET /api/openclaw/models
 *
 * Returns available models for Mission Control integrated runtime mode.
 * Source of truth is Model Hub pipeline (`p1`) with fallback provider defaults.
 */
export async function GET() {
  try {
    const payload = buildIntegratedModelInfo();
    return NextResponse.json<OpenClawModelsResponse>(payload);
  } catch (error) {
    console.error('Failed to resolve runtime models:', error);
    return NextResponse.json<OpenClawModelsResponse>({
      ...buildFallbackModelInfo(),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

function buildIntegratedModelInfo(): ModelInfoResponse {
  const service = getModelHubService();
  const pipeline = service
    .listPipeline(DEFAULT_PROFILE_ID)
    .slice()
    .sort((a, b) => a.priority - b.priority);

  if (pipeline.length === 0) {
    return buildFallbackModelInfo();
  }

  const activeModels = pipeline.filter((entry) => entry.status === 'active');
  const ordered = activeModels.length > 0 ? activeModels : pipeline;
  const availableModels = Array.from(
    new Set(ordered.map((entry) => entry.modelName.trim())),
  ).filter((name) => name.length > 0);

  return {
    defaultModel: availableModels[0],
    availableModels,
  };
}

function buildFallbackModelInfo(): ModelInfoResponse {
  const availableModels = Array.from(
    new Set(
      PROVIDER_CATALOG.flatMap((provider) =>
        provider.defaultModels.map((model) => model.trim()).filter((model) => model.length > 0),
      ),
    ),
  ).sort();

  return {
    defaultModel: availableModels[0],
    availableModels,
  };
}
