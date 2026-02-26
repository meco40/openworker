import { AgentV2Error } from '@/server/agent-v2/errors';
import { AgentV2Repository } from '@/server/agent-v2/repository';
import type {
  ExtensionManifestV1,
  LifecycleHookContext,
  LifecycleHookOutcome,
  LifecycleHookStage,
} from '@/server/agent-v2/types';
import {
  buildAllowlistKey,
  parseExtensionAllowlistFromEnv,
  validateExtensionManifest,
} from '@/server/agent-v2/extensions/security';
import { ExtensionWorkerHost } from '@/server/agent-v2/extensions/workerHost';

const DEFAULT_HOOK_TIMEOUT_MS = 2_000;

interface LoadedExtension {
  manifest: ExtensionManifestV1;
  host: ExtensionWorkerHost;
}

export class AgentV2ExtensionHost {
  private readonly loaded = new Map<string, LoadedExtension>();
  private killSwitchEnabled = true;

  constructor(private readonly repository: AgentV2Repository) {
    this.killSwitchEnabled = resolveExtensionsEnabledFlag();
  }

  refresh(): void {
    this.killSwitchEnabled = resolveExtensionsEnabledFlag();
    if (!this.killSwitchEnabled) {
      this.stopAll();
      return;
    }

    const allowlist = parseExtensionAllowlistFromEnv();
    const signingKeys = new Map(this.repository.listSigningKeys().map((key) => [key.keyId, key]));
    const revoked = this.repository.listRevokedSignatureDigests();
    const manifests = this.repository.listEnabledExtensionManifests();
    const keep = new Set<string>();

    for (const manifest of manifests) {
      const extensionKey = buildAllowlistKey(manifest);
      const validation = validateExtensionManifest(manifest, {
        allowlist,
        signingKeys,
        revokedSignatureDigests: revoked,
      });
      if (!validation.ok) {
        console.warn(`[agent-v2] Extension rejected (${extensionKey}): ${validation.reason}`);
        continue;
      }

      keep.add(extensionKey);
      if (this.loaded.has(extensionKey)) continue;

      const workerHost = new ExtensionWorkerHost(manifest);
      this.loaded.set(extensionKey, {
        manifest,
        host: workerHost,
      });
    }

    for (const [loadedKey, loaded] of this.loaded.entries()) {
      if (!keep.has(loadedKey)) {
        loaded.host.stop();
        this.loaded.delete(loadedKey);
      }
    }
  }

  async runHooks(
    stage: LifecycleHookStage,
    context: LifecycleHookContext,
  ): Promise<LifecycleHookOutcome[]> {
    if (!this.killSwitchEnabled) return [];
    const outcomes: LifecycleHookOutcome[] = [];

    for (const loaded of this.loaded.values()) {
      if (!loaded.manifest.hookStages.includes(stage)) continue;
      const startedAt = Date.now();
      const policy: LifecycleHookOutcome['policy'] = loaded.manifest.failClosedStages?.includes(
        stage,
      )
        ? 'fail_closed'
        : 'fail_open';
      const timeoutMs = resolveHookTimeoutMs(loaded.manifest.timeoutMs);
      const result = await loaded.host.runHook(stage, context, timeoutMs);
      const durationMs = Date.now() - startedAt;
      if (!result.ok) {
        outcomes.push({
          ok: false,
          extensionId: loaded.manifest.id,
          stage,
          error: result.error,
          durationMs,
          policy,
        });
        if (policy === 'fail_closed') {
          throw new AgentV2Error(
            `Lifecycle hook failed in fail-closed mode (${loaded.manifest.id}): ${result.error || 'unknown error'}`,
            'UNAVAILABLE',
          );
        }
        continue;
      }

      outcomes.push({
        ok: true,
        extensionId: loaded.manifest.id,
        stage,
        durationMs,
        policy,
      });
    }

    return outcomes;
  }

  stopAll(): void {
    for (const loaded of this.loaded.values()) {
      loaded.host.stop();
    }
    this.loaded.clear();
  }
}

function resolveHookTimeoutMs(manifestTimeoutMs?: number): number {
  if (Number.isFinite(manifestTimeoutMs) && manifestTimeoutMs && manifestTimeoutMs > 0) {
    return Math.max(50, Math.min(Math.floor(manifestTimeoutMs), 60_000));
  }
  const raw = Number.parseInt(String(process.env.AGENT_V2_HOOK_TIMEOUT_MS || ''), 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_HOOK_TIMEOUT_MS;
  return Math.max(50, Math.min(raw, 60_000));
}

function resolveExtensionsEnabledFlag(): boolean {
  const raw = String(process.env.AGENT_V2_EXTENSIONS_ENABLED || 'true')
    .trim()
    .toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}
