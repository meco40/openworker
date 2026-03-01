import crypto from 'node:crypto';
import type { MasterSqliteDb } from '@/server/master/repository/db';
import { nowIso } from '@/server/master/repository/helpers';
import { toConnectorSecret } from '@/server/master/repository/mappers';
import type { MasterConnectorSecret, WorkspaceScope } from '@/server/master/types';

export function upsertConnectorSecret(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  secret: Omit<MasterConnectorSecret, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>,
): MasterConnectorSecret {
  const now = nowIso();
  db.prepare(
    `INSERT INTO master_connector_secrets (
       id, user_id, workspace_id, provider, key_ref, encrypted_payload, issued_at, expires_at, revoked_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, workspace_id, provider, key_ref)
     DO UPDATE SET
       encrypted_payload = excluded.encrypted_payload,
       issued_at = excluded.issued_at,
       expires_at = excluded.expires_at,
       revoked_at = excluded.revoked_at,
       updated_at = excluded.updated_at`,
  ).run(
    crypto.randomUUID(),
    scope.userId,
    scope.workspaceId,
    secret.provider,
    secret.keyRef,
    secret.encryptedPayload,
    secret.issuedAt,
    secret.expiresAt,
    secret.revokedAt,
    now,
    now,
  );
  return getConnectorSecret(db, scope, secret.provider, secret.keyRef)!;
}

export function getConnectorSecret(
  db: MasterSqliteDb,
  scope: WorkspaceScope,
  provider: string,
  keyRef: string,
): MasterConnectorSecret | null {
  const row = db
    .prepare(
      `SELECT * FROM master_connector_secrets
       WHERE user_id = ? AND workspace_id = ? AND provider = ? AND key_ref = ?`,
    )
    .get(scope.userId, scope.workspaceId, provider, keyRef) as Record<string, unknown> | undefined;
  return row ? toConnectorSecret(row) : null;
}
