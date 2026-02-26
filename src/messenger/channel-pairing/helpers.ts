import type { CoupledChannel } from '@/shared/domain/types';
import type { BridgeTab } from './types';

export const BRIDGE_TABS: BridgeTab[] = ['whatsapp', 'imessage'];
export const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function mapBridgeStatusToUiStatus(
  status: string | null | undefined,
): CoupledChannel['status'] {
  if (status === 'connected') return 'connected';
  if (status === 'awaiting_code') return 'awaiting_code';
  if (status === 'pairing') return 'pairing';
  return 'idle';
}

export function normalizeAccountId(input: string): string {
  return input.trim().toLowerCase();
}
