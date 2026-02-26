import type { FetchedModel, ConnectivityResult } from '@/server/model-hub/Models/types';
import { fetchWithTimeout } from '@/server/model-hub/Models/shared/http';
import { buildOptionalAuthHeaders, buildModelsUrl } from '../utils';
import type { ModelsResponseJson } from '../types';

export async function fetchOpenAICompatibleModels(
  baseUrl: string,
  secret: string,
  providerId: string,
): Promise<FetchedModel[]> {
  const url = buildModelsUrl(baseUrl);
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: buildOptionalAuthHeaders(secret),
  });

  if (!response.ok) return [];

  const json = (await response.json()) as ModelsResponseJson;

  return (json.data ?? []).map((model) => ({
    id: model.id,
    name: model.id,
    provider: providerId,
    owned_by: model.owned_by,
    created: model.created,
  }));
}

export async function testOpenAICompatibleModelsEndpoint(
  baseUrl: string,
  secret: string,
  successMessage: string,
  failurePrefix: string,
): Promise<ConnectivityResult> {
  try {
    const url = buildModelsUrl(baseUrl);
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: buildOptionalAuthHeaders(secret),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        message: `${failurePrefix}${text || `HTTP ${response.status}`}`,
      };
    }

    return { ok: true, message: successMessage };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network request failed.';
    return { ok: false, message: `${failurePrefix}${message}` };
  }
}
