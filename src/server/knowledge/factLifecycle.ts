/** Compatibility exports for the shared Memory lifecycle implementation. */
export {
  isActiveMemoryMetadata,
  isActiveStatus,
  resolveLifecycleStatus,
  transitionLifecycle,
  withLifecycleSignal,
  type LifecycleSignal,
  type LifecycleStatus,
} from '@/server/memory/lifecycle';
