import type { WorkerTaskStatus } from '../workerTypes';

export type OpenAiWorkerRunState =
  | 'planning'
  | 'running'
  | 'awaiting_approval'
  | 'testing'
  | 'review'
  | 'completed'
  | 'failed';

const STATUS_MAP: Record<OpenAiWorkerRunState, WorkerTaskStatus> = {
  planning: 'planning',
  running: 'executing',
  awaiting_approval: 'waiting_approval',
  testing: 'testing',
  review: 'review',
  completed: 'completed',
  failed: 'failed',
};

export function mapOpenAiRunStateToWorkerStatus(state: OpenAiWorkerRunState): WorkerTaskStatus {
  return STATUS_MAP[state];
}

export function parseOpenAiRunState(input: string): OpenAiWorkerRunState {
  if (Object.prototype.hasOwnProperty.call(STATUS_MAP, input)) {
    return input as OpenAiWorkerRunState;
  }
  throw new Error(`Unsupported OpenAI worker run state: ${input}`);
}

