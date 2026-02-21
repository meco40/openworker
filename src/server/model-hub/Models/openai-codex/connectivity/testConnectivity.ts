import type { ConnectivityResult, GatewayRequest } from '@/server/model-hub/Models/types';
import { resolveCodexProbeModel } from '../client/config';
import { dispatchCodexResponses } from '../client/dispatch';

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
  if (result.ok) {
    return {
      ok: true,
      message: `OpenAI Codex connectivity verified (codex responses reachable with model ${probeModel}).`,
    };
  }

  return {
    ok: false,
    message: `OpenAI Codex connectivity failed: ${result.error || 'Codex probe failed.'}`,
  };
}
