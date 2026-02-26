// This file has been modularized.
// The original implementation has been split into the following modules:
// - repository/types.ts - Type definitions
// - repository/migrations.ts - Database migrations
// - repository/sessionRepository.ts - Session management
// - repository/commandRepository.ts - Command management
// - repository/eventRepository.ts - Event management
// - repository/extensionRepository.ts - Extension management
// - repository/signingKeyRepository.ts - Signing key management
// - repository/recoveryRepository.ts - Recovery operations
// - repository/utils.ts - Shared utility functions
//
// This file re-exports everything from the new modular structure
// for backward compatibility.

export * from './repository/index';
export { AgentV2Repository as default } from './repository/index';
