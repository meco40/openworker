import { resolveModelHubGatewayTimeoutMs } from '@/server/model-hub/Models/shared/http';

export function shouldUseStream(requestStream?: boolean): boolean {
  return requestStream === true;
}

export function resolveTimeoutMs(hasTools: boolean): number {
  return resolveModelHubGatewayTimeoutMs({ hasTools });
}
