/**
 * Session state operations module.
 * Re-exports all state management functions.
 */

export { startSession, type CreateSessionContext } from './create';
export { getSession, listSessions, type UpdateSessionContext } from './update';
export {
  performStartupRecovery,
  close,
  isProcessing,
  markProcessing,
  unmarkProcessing,
  type LifecycleContext,
} from './lifecycle';
