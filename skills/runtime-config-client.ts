export type RuntimeConfigValueKind = 'secret' | 'text';
export type RuntimeConfigSource = 'store' | 'env' | null;

export interface SkillRuntimeConfigStatus {
  id: string;
  skillId: string;
  label: string;
  description: string;
  kind: RuntimeConfigValueKind;
  required: boolean;
  envVars: string[];
  configured: boolean;
  source: RuntimeConfigSource;
  maskedValue: string | null;
  updatedAt: string | null;
}

interface RuntimeConfigListResponse {
  ok: boolean;
  configs?: SkillRuntimeConfigStatus[];
  error?: string;
}

interface RuntimeConfigMutationResponse {
  ok: boolean;
  config?: SkillRuntimeConfigStatus;
  error?: string;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function listSkillRuntimeConfigs(): Promise<RuntimeConfigListResponse> {
  const response = await fetch('/api/skills/runtime-config');
  return readJson<RuntimeConfigListResponse>(response);
}

export async function setSkillRuntimeConfig(
  id: string,
  value: string,
): Promise<RuntimeConfigMutationResponse> {
  const response = await fetch('/api/skills/runtime-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, value }),
  });
  return readJson<RuntimeConfigMutationResponse>(response);
}

export async function clearSkillRuntimeConfig(id: string): Promise<RuntimeConfigMutationResponse> {
  const response = await fetch(`/api/skills/runtime-config?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return readJson<RuntimeConfigMutationResponse>(response);
}
