import crypto from 'node:crypto';
import type { AgentV2SigningKeyRecord, ExtensionManifestV1 } from '@/server/agent-v2/types';

export interface ExtensionValidationContext {
  signingKeys: Map<string, AgentV2SigningKeyRecord>;
  revokedSignatureDigests: Set<string>;
  allowlist: Set<string>;
}

export interface ExtensionValidationResult {
  ok: boolean;
  reason?: string;
}

export function parseExtensionAllowlistFromEnv(): Set<string> {
  const raw = String(process.env.AGENT_V2_EXTENSION_ALLOWLIST || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return new Set(raw);
}

export function buildAllowlistKey(manifest: ExtensionManifestV1): string {
  return `${manifest.id}@${manifest.version}@${manifest.digest}`;
}

export function computeManifestDigest(manifest: ExtensionManifestV1): string {
  const canonical = canonicalManifestPayload(manifest);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function computeSignatureDigest(signature: string): string {
  return crypto.createHash('sha256').update(signature).digest('hex');
}

export function validateExtensionManifest(
  manifest: ExtensionManifestV1,
  ctx: ExtensionValidationContext,
): ExtensionValidationResult {
  const key = buildAllowlistKey(manifest);
  if (!ctx.allowlist.has(key)) {
    return { ok: false, reason: `Extension not allowlisted: ${key}` };
  }

  const keyRecord = ctx.signingKeys.get(manifest.keyId);
  if (!keyRecord || keyRecord.status !== 'active') {
    return { ok: false, reason: `Signing key is not active: ${manifest.keyId}` };
  }

  const computedDigest = computeManifestDigest(manifest);
  if (computedDigest !== manifest.digest) {
    return {
      ok: false,
      reason: `Manifest digest mismatch for ${manifest.id}@${manifest.version}.`,
    };
  }

  const signatureDigest = computeSignatureDigest(manifest.signature);
  if (ctx.revokedSignatureDigests.has(signatureDigest)) {
    return {
      ok: false,
      reason: `Signature has been revoked for ${manifest.id}@${manifest.version}.`,
    };
  }

  const verified = verifyManifestSignature(manifest, keyRecord.publicKeyPem);
  if (!verified) {
    return {
      ok: false,
      reason: `Signature verification failed for ${manifest.id}@${manifest.version}.`,
    };
  }

  return { ok: true };
}

export function verifyManifestSignature(
  manifest: ExtensionManifestV1,
  publicKeyPem: string,
): boolean {
  try {
    const verifier = crypto.createVerify('sha256');
    verifier.update(canonicalManifestPayload(manifest));
    verifier.end();
    return verifier.verify(publicKeyPem, manifest.signature, 'base64');
  } catch {
    return false;
  }
}

function canonicalManifestPayload(manifest: ExtensionManifestV1): string {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    version: manifest.version,
    keyId: manifest.keyId,
    modulePath: manifest.modulePath,
    hookStages: [...manifest.hookStages].sort(),
    failClosedStages: [...(manifest.failClosedStages || [])].sort(),
    timeoutMs: manifest.timeoutMs ?? null,
  });
}
