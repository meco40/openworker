import type { GatewayResponse } from '@/server/model-hub/Models/types';
import type { ErrorResponseJson } from '../types';

export function parseErrorResponse(
  status: number,
  errorText: string,
  requestModel: string,
  providerId: string,
): GatewayResponse {
  let errorMessage: string;

  try {
    const errorJson = JSON.parse(errorText) as ErrorResponseJson;
    if (typeof errorJson.error === 'string') {
      errorMessage = errorJson.error;
    } else if (typeof errorJson.error?.message === 'string') {
      errorMessage = errorJson.error.message;
    } else {
      errorMessage = errorText || `HTTP ${status}`;
    }
  } catch {
    errorMessage = errorText || `HTTP ${status}`;
  }

  return {
    ok: false,
    text: '',
    model: requestModel,
    provider: providerId,
    error: errorMessage,
  };
}

export function createErrorResponse(
  error: unknown,
  requestModel: string,
  providerId: string,
): GatewayResponse {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return {
    ok: false,
    text: '',
    model: requestModel,
    provider: providerId,
    error: message,
  };
}
