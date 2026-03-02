// Modularized SqliteMessageRepository
// This file re-exports from the main sqliteMessageRepository.ts for backward compatibility
// and provides a cleaner import path for new code.

export { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';

// Re-export types from the types module
export type {
  StoredMessage,
  CreateConversationInput,
  SaveMessageInput,
  ConversationContextState,
  PersonaProjectRecord,
  ConversationProjectState,
  AgentRoomSwarmStatus,
  AgentRoomSwarmPhase,
  AgentRoomSwarmUnit,
  AgentRoomSwarmFriction,
  AgentRoomSwarmRecord,
  AgentRoomSwarmMetrics,
  SearchMessagesOptions,
} from '@/server/channels/messages/repository/types';
