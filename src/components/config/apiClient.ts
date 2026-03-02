import type { ConfigResponse } from '@/components/shared/configTypes';

interface ConfigApiResult {
  response: Response;
  payload: ConfigResponse;
}

export async function loadConfigFromApi(): Promise<ConfigApiResult> {
  const response = await fetch('/api/config', { cache: 'no-store' });
  const payload = (await response.json()) as ConfigResponse;
  return { response, payload };
}

export async function saveConfigToApi(
  config: Record<string, unknown>,
  revision: string,
): Promise<ConfigApiResult> {
  const response = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config, revision }),
  });
  const payload = (await response.json()) as ConfigResponse;
  return { response, payload };
}
