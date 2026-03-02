import type BetterSqlite3 from 'better-sqlite3';
import { openSqliteDatabase } from '@/server/db/sqlite';
import type {
  AgentCommand,
  AgentSessionSnapshot,
  AgentV2EventEnvelope,
  AgentV2EventType,
  AgentV2SessionStatus,
  AgentV2SigningKeyRecord,
  ExtensionManifestV1,
} from '@/server/agent-v2/types';

// Re-export all types from types.ts
export type {
  SessionRow,
  CommandRow,
  EventRow,
  ExtensionRow,
  EnqueueAgentCommandInput,
  EnqueueAgentCommandResult,
  StartNextCommandResult,
  CompleteCommandInput,
  CompleteCommandResult,
} from './types';

// Re-export types from specialized modules
export type { CreateSessionInput, CreateSessionResult } from './sessionRepository';
export type { AppendEventInput, ReplayEventsInput } from './eventRepository';
export type { UpsertSigningKeyInput } from './signingKeyRepository';
export type { RecoveryResult } from './recoveryRepository';

// Import repository modules
import { runMigrations } from './migrations';
import { createSession, getSession, listSessions } from './sessionRepository';
import {
  completeCommand,
  countQueuedCommands,
  enqueueCommand,
  hasQueuedAbort,
  startNextQueuedCommand,
} from './commandRepository';
import { appendEvent, getCommandResult, pruneExpiredEvents, replayEvents } from './eventRepository';
import { listEnabledExtensionManifests, upsertExtensionManifest } from './extensionRepository';
import {
  listRevokedSignatureDigests,
  listSigningKeys,
  revokeSignature,
  upsertSigningKey,
} from './signingKeyRepository';
import { recoverRunningCommandsOnStartup } from './recoveryRepository';
import type { CompleteCommandInput, EnqueueAgentCommandInput } from './types';

/**
 * Main AgentV2Repository class that delegates to specialized modules.
 * Maintains backward compatibility with the original API.
 */
export class AgentV2Repository {
  private readonly db: BetterSqlite3.Database;

  constructor(dbPath = process.env.MESSAGES_DB_PATH || '.local/messages.db') {
    this.db = openSqliteDatabase({ dbPath });
    this.migrate();
  }

  private migrate(): void {
    runMigrations(this.db);
  }

  // Session methods
  createSession(input: { userId: string; conversationId: string; status?: AgentV2SessionStatus }): {
    session: AgentSessionSnapshot;
    events: AgentV2EventEnvelope[];
  } {
    return createSession(this.db, input);
  }

  getSession(sessionId: string, userId: string): AgentSessionSnapshot | null {
    return getSession(this.db, sessionId, userId);
  }

  listSessions(userId: string, limit?: number): AgentSessionSnapshot[] {
    return listSessions(this.db, userId, limit);
  }

  // Command methods
  countQueuedCommands(sessionId: string, userId: string): number {
    return countQueuedCommands(this.db, sessionId, userId);
  }

  hasQueuedAbort(sessionId: string): boolean {
    return hasQueuedAbort(this.db, sessionId);
  }

  enqueueCommand(input: EnqueueAgentCommandInput) {
    return enqueueCommand(this.db, input);
  }

  startNextQueuedCommand(
    sessionId: string,
    userId: string,
  ): {
    command: AgentCommand;
    session: AgentSessionSnapshot;
    events: AgentV2EventEnvelope[];
  } | null {
    return startNextQueuedCommand(this.db, sessionId, userId);
  }

  completeCommand(input: CompleteCommandInput) {
    return completeCommand(this.db, input);
  }

  // Event methods
  appendEvent(input: {
    sessionId: string;
    userId: string;
    commandId?: string | null;
    type: AgentV2EventType;
    payload: Record<string, unknown>;
  }): AgentV2EventEnvelope {
    return appendEvent(this.db, input);
  }

  replayEvents(input: {
    sessionId: string;
    userId: string;
    fromSeq: number;
    limit?: number;
  }): AgentV2EventEnvelope[] {
    return replayEvents(this.db, input);
  }

  getCommandResult(commandId: string, sessionId: string): AgentV2EventEnvelope | null {
    return getCommandResult(this.db, commandId, sessionId);
  }

  pruneExpiredEvents(now?: Date): number {
    return pruneExpiredEvents(this.db, now);
  }

  // Recovery methods
  recoverRunningCommandsOnStartup(): { recoveredCommands: number; touchedSessions: number } {
    return recoverRunningCommandsOnStartup(this.db);
  }

  // Extension methods
  upsertExtensionManifest(manifest: ExtensionManifestV1, enabled?: boolean): void {
    return upsertExtensionManifest(this.db, manifest, enabled);
  }

  listEnabledExtensionManifests(): ExtensionManifestV1[] {
    return listEnabledExtensionManifests(this.db);
  }

  // Signing key methods
  upsertSigningKey(input: {
    keyId: string;
    algorithm: string;
    publicKeyPem: string;
    status?: 'active' | 'rotated' | 'revoked';
    rotatedAt?: string | null;
    revokedAt?: string | null;
  }): void {
    return upsertSigningKey(this.db, input);
  }

  listSigningKeys(): AgentV2SigningKeyRecord[] {
    return listSigningKeys(this.db);
  }

  revokeSignature(signatureDigest: string, reason?: string): void {
    return revokeSignature(this.db, signatureDigest, reason);
  }

  listRevokedSignatureDigests(): Set<string> {
    return listRevokedSignatureDigests(this.db);
  }

  // Utility methods
  close(): void {
    this.db.close();
  }
}

// Re-export the specialized modules for direct access if needed
export * as migrations from './migrations';
export * as sessionRepository from './sessionRepository';
export * as commandRepository from './commandRepository';
export * as eventRepository from './eventRepository';
export * as extensionRepository from './extensionRepository';
export * as signingKeyRepository from './signingKeyRepository';
export * as recoveryRepository from './recoveryRepository';
export * as utils from './utils';
