/**
 * @deprecated This file is being refactored into the prompt/ module.
 * Re-exports are maintained for backward compatibility.
 */

// Re-export all from new modular structure
export {
  buildSimpleTurnPrompt,
  buildPhaseGuidance,
  chooseNextSpeakerPersonaId,
  parseTurnDirectives,
  stripLeadingSpeakerPrefix,
  stripTrailingOtherSpeakerTurns,
  countStructuredTurns,
  countTurnsInCurrentPhase,
  extractRecentTurnHistory,
  computeNextPhaseAfterTurn,
  getPhaseRounds,
  getSimpleSwarmMaxTurns,
  shouldCompleteSwarmAfterTurnWithTurnCount,
  shouldCompleteSwarmAfterTurn,
  getTurnsRequiredForPhase,
} from '@/server/agent-room/prompt';
