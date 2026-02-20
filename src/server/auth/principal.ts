import { LEGACY_LOCAL_USER_ID } from '@/server/auth/constants';

export function getPrincipalUserId(): string {
  const configured = String(process.env.PRINCIPAL_USER_ID || '').trim();
  return configured || LEGACY_LOCAL_USER_ID;
}
