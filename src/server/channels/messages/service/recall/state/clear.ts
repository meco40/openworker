/**
 * State management operations
 */

import type { LastRecallState } from '../../types';
import { MEM0_EMPTY_SCOPE_TTL_MS } from '../constants';

/**
 * Manages conversation recall state and empty Mem0 scope cache
 */
export class RecallStateManager {
  private lastRecallByConversation = new Map<string, LastRecallState>();
  private emptyMem0ScopeCache = new Map<string, number>();

  /**
   * Get the recall state for a conversation
   */
  getState(conversationId: string): LastRecallState | undefined {
    return this.lastRecallByConversation.get(conversationId);
  }

  /**
   * Set the recall state for a conversation
   */
  setState(conversationId: string, state: LastRecallState): void {
    this.lastRecallByConversation.set(conversationId, state);
  }

  /**
   * Delete the recall state for a conversation
   */
  deleteState(conversationId: string): void {
    this.lastRecallByConversation.delete(conversationId);
  }

  /**
   * Generate cache key for Mem0 scope
   */
  private getMem0ScopeKey(personaId: string, userId: string): string {
    return `${personaId}::${userId}`;
  }

  /**
   * Check if Mem0 scope is temporarily marked as empty
   */
  isMem0ScopeTemporarilyEmpty(personaId: string, userId: string): boolean {
    const key = this.getMem0ScopeKey(personaId, userId);
    const expiresAt = this.emptyMem0ScopeCache.get(key);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.emptyMem0ScopeCache.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Mark Mem0 scope as temporarily empty
   */
  markMem0ScopeTemporarilyEmpty(personaId: string, userId: string): void {
    const key = this.getMem0ScopeKey(personaId, userId);
    this.emptyMem0ScopeCache.set(key, Date.now() + MEM0_EMPTY_SCOPE_TTL_MS);
  }

  /**
   * Clear the empty marker for a Mem0 scope
   */
  clearMem0ScopeEmptyMarker(personaId: string, userId: string): void {
    const key = this.getMem0ScopeKey(personaId, userId);
    this.emptyMem0ScopeCache.delete(key);
  }
}
