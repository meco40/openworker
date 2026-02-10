
/**
 * Generic browser logic that can be called by any model provider.
 */
import { executeSkillApi } from '../runtime-client';

export const execute = async (args: { url?: string; format?: string; quality?: number }) =>
  executeSkillApi('browser_snapshot', args);
