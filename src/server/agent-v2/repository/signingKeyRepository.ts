import type BetterSqlite3 from 'better-sqlite3';
import type { AgentV2SigningKeyRecord } from '@/server/agent-v2/types';

export interface UpsertSigningKeyInput {
  keyId: string;
  algorithm: string;
  publicKeyPem: string;
  status?: 'active' | 'rotated' | 'revoked';
  rotatedAt?: string | null;
  revokedAt?: string | null;
}

export function upsertSigningKey(db: BetterSqlite3.Database, input: UpsertSigningKeyInput): void {
  const now = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO agent_v2_signing_keys (
        key_id, algorithm, public_key_pem, status, created_at, rotated_at, revoked_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key_id)
      DO UPDATE SET
        algorithm = excluded.algorithm,
        public_key_pem = excluded.public_key_pem,
        status = excluded.status,
        rotated_at = excluded.rotated_at,
        revoked_at = excluded.revoked_at
    `,
  ).run(
    input.keyId,
    input.algorithm,
    input.publicKeyPem,
    input.status ?? 'active',
    now,
    input.rotatedAt ?? null,
    input.revokedAt ?? null,
  );
}

export function listSigningKeys(db: BetterSqlite3.Database): AgentV2SigningKeyRecord[] {
  const rows = db
    .prepare(
      `
      SELECT *
      FROM agent_v2_signing_keys
    `,
    )
    .all() as Array<{
    key_id: string;
    algorithm: string;
    public_key_pem: string;
    status: 'active' | 'rotated' | 'revoked';
    created_at: string;
    rotated_at: string | null;
    revoked_at: string | null;
  }>;
  return rows.map((row) => ({
    keyId: row.key_id,
    algorithm: row.algorithm,
    publicKeyPem: row.public_key_pem,
    status: row.status,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
  }));
}

export function revokeSignature(
  db: BetterSqlite3.Database,
  signatureDigest: string,
  reason?: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO agent_v2_revoked_signatures (signature_digest, reason, revoked_at)
      VALUES (?, ?, ?)
      ON CONFLICT(signature_digest)
      DO UPDATE SET reason = excluded.reason, revoked_at = excluded.revoked_at
    `,
  ).run(signatureDigest, reason ?? null, now);
}

export function listRevokedSignatureDigests(db: BetterSqlite3.Database): Set<string> {
  const rows = db
    .prepare('SELECT signature_digest FROM agent_v2_revoked_signatures')
    .all() as Array<{ signature_digest: string }>;
  return new Set(rows.map((row) => row.signature_digest));
}
