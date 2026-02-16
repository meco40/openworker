export interface OpenAiWorkerTool {
  id: string;
  name: string;
  description: string;
  functionName: string;
  enabled: boolean;
}

interface OpenAiWorkerToolsListResponse {
  ok: boolean;
  tools?: OpenAiWorkerTool[];
  error?: string;
}

interface OpenAiWorkerToolMutationResponse {
  ok: boolean;
  tool?: OpenAiWorkerTool;
  error?: string;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function listOpenAiWorkerTools(): Promise<OpenAiWorkerToolsListResponse> {
  const response = await fetch('/api/worker/openai/tools');
  return readJson<OpenAiWorkerToolsListResponse>(response);
}

export async function setOpenAiWorkerToolState(
  id: string,
  enabled: boolean,
): Promise<OpenAiWorkerToolMutationResponse> {
  const response = await fetch('/api/worker/openai/tools', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, enabled }),
  });
  return readJson<OpenAiWorkerToolMutationResponse>(response);
}
