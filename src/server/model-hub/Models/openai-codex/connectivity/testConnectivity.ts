import type { ConnectivityResult, GatewayRequest } from '@/server/model-hub/Models/types';
import { resolveCodexProbeModel } from '../client/config';
import { dispatchCodexResponses } from '../client/dispatch';
import { fetchCodexUsageRateLimits } from '../client/usage';
import { mergeRateLimitSnapshots } from '../parsers/usageRateLimitParser';

export async function testOpenAICodexConnectivity(params: {
  secret: string;
  defaultModels: string[];
  model?: string;
}): Promise<ConnectivityResult> {
  const probeModel = resolveCodexProbeModel(params.model, params.defaultModels);
  const probeRequest: GatewayRequest = {
    model: probeModel,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 16,
  };

  const result = await dispatchCodexResponses(params.secret, probeRequest);
  let usageRateLimits;
  try {
    usageRateLimits = await fetchCodexUsageRateLimits(params.secret);
  } catch {
    usageRateLimits = undefined;
  }
  const rateLimits = mergeRateLimitSnapshots(result.rateLimits, usageRateLimits);
  if (result.ok) {
    return {
      ok: true,
      message: `OpenAI Codex connectivity verified (codex responses reachable with model ${probeModel}).`,
      rateLimits,
    };
  }

  return {
    ok: false,
    message: `OpenAI Codex connectivity failed: ${result.error || 'Codex probe failed.'}`,
    rateLimits,
  };
}
