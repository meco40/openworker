// Re-export shared debug types for use within the conversation-debugger module
export type { DebugConversationSummary, DebugTurn } from '@/shared/domain/types';

export interface DebuggerState {
  selectedConversationId: string | null;
  selectedTurnSeq: number | null;
  replayFromSeq: number | null;
}
