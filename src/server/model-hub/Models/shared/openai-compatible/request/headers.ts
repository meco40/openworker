import { buildOptionalAuthHeaders } from '../utils';
import { CONTENT_TYPE_JSON } from '../constants';

export function buildRequestHeaders(
  secret: string,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    'Content-Type': CONTENT_TYPE_JSON,
    ...buildOptionalAuthHeaders(secret),
    ...(extraHeaders ?? {}),
  };
}
