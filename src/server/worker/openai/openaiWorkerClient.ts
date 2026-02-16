import { loadGatewayConfig } from '../../config/gatewayConfig';

export interface OpenAiWorkerStartRunInput {
  taskId: string;
  title: string;
  objective: string;
  userId?: string | null;
  workspacePath?: string | null;
}

export interface OpenAiWorkerStartRunResult {
  runId: string;
  status: 'running' | 'approval_required' | 'completed' | 'failed';
  output?: string;
  approvalToken?: string;
}

export interface OpenAiWorkerSubmitApprovalInput {
  approvalToken: string;
  approved: boolean;
  approveAlways?: boolean;
}

export interface OpenAiWorkerClient {
  startRun(input: OpenAiWorkerStartRunInput): Promise<OpenAiWorkerStartRunResult>;
  cancelRun(runId: string): Promise<{ ok: boolean }>;
  submitApproval(input: OpenAiWorkerSubmitApprovalInput): Promise<{ ok: boolean }>;
}

interface OpenAiWorkerClientConfig {
  sidecarUrl: string;
  callbackToken?: string;
}

function getNestedObject(root: unknown, key: string): Record<string, unknown> {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return {};
  const value = (root as Record<string, unknown>)[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

async function resolveClientConfig(): Promise<OpenAiWorkerClientConfig> {
  const state = await loadGatewayConfig();
  const worker = getNestedObject(state.config, 'worker');
  const openai = getNestedObject(worker, 'openai');

  const cfgSidecarUrl =
    typeof openai.sidecarUrl === 'string' && openai.sidecarUrl.trim().length > 0
      ? openai.sidecarUrl.trim()
      : undefined;
  const cfgToken =
    typeof openai.callbackToken === 'string' && openai.callbackToken.trim().length > 0
      ? openai.callbackToken.trim()
      : undefined;

  return {
    sidecarUrl:
      process.env.OPENAI_WORKER_SIDECAR_URL ||
      cfgSidecarUrl ||
      'http://127.0.0.1:8011',
    callbackToken: process.env.OPENAI_WORKER_TOKEN || cfgToken,
  };
}

async function postJson<T>(url: string, body: unknown, token?: string): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI sidecar request failed: ${response.status} ${text}`.trim());
  }
  return (await response.json()) as T;
}

class HttpOpenAiWorkerClient implements OpenAiWorkerClient {
  async startRun(input: OpenAiWorkerStartRunInput): Promise<OpenAiWorkerStartRunResult> {
    const config = await resolveClientConfig();
    const response = await postJson<{
      runId?: string;
      status?: string;
      output?: string;
      approval_token?: string;
      approvalToken?: string;
    }>(
      `${config.sidecarUrl}/runs/start`,
      {
        runId: input.taskId,
        objective: input.objective,
        requireApproval: false,
      },
      config.callbackToken,
    );
    const rawStatus = response.status || 'running';
    const mappedStatus =
      rawStatus === 'paused'
        ? 'approval_required'
        : rawStatus === 'cancelled'
          ? 'failed'
          : (rawStatus as OpenAiWorkerStartRunResult['status']);
    return {
      runId: response.runId || input.taskId,
      status: mappedStatus,
      output: response.output,
      approvalToken: response.approvalToken || response.approval_token,
    };
  }

  async cancelRun(runId: string): Promise<{ ok: boolean }> {
    const config = await resolveClientConfig();
    await postJson<{ status: string }>(
      `${config.sidecarUrl}/runs/${encodeURIComponent(runId)}/cancel`,
      {},
      config.callbackToken,
    );
    return { ok: true };
  }

  async submitApproval(input: OpenAiWorkerSubmitApprovalInput): Promise<{ ok: boolean }> {
    const config = await resolveClientConfig();
    await postJson<{ status: string }>(
      `${config.sidecarUrl}/approvals/${encodeURIComponent(input.approvalToken)}/resume`,
      {
        approved: input.approved,
        payload: {
          approveAlways: Boolean(input.approveAlways),
        },
      },
      config.callbackToken,
    );
    return { ok: true };
  }
}

let clientInstance: OpenAiWorkerClient | null = null;

export function getOpenAiWorkerClient(): OpenAiWorkerClient {
  if (!clientInstance) {
    clientInstance = new HttpOpenAiWorkerClient();
  }
  return clientInstance;
}

export function setOpenAiWorkerClientForTests(client: OpenAiWorkerClient | null): void {
  clientInstance = client;
}
