/**
 * OpenAI-Compatible Model Provider
 *
 * @deprecated This file is kept for backward compatibility.
 * Please import from `@/server/model-hub/Models/shared/openai-compatible` instead.
 */

// Re-export everything from the new modular location
export * from './openai-compatible';

// Re-export default (if any named exports should be default)
export { dispatchOpenAICompatibleChat as default } from './openai-compatible';
