import { executeDispatch } from './executeDispatch';
import { finalizeDispatch } from './finalizeDispatch';
import { prepareDispatch } from './prepareDispatch';
import type { DispatchHttpResponse } from './types';

export async function dispatchTask(taskId: string): Promise<DispatchHttpResponse> {
  const preparation = await prepareDispatch(taskId);
  if (preparation.kind === 'response') {
    return preparation.response;
  }

  try {
    const execution = await executeDispatch(preparation.context);
    if (execution.kind === 'response') {
      return execution.response;
    }

    return finalizeDispatch(preparation.context, execution.sendResult);
  } catch (error) {
    console.error('Failed to send message to agent:', error);
    return {
      status: 500,
      body: { error: 'Internal server error' },
    };
  }
}
