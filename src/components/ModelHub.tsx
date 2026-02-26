/**
 * ModelHub Component - Backward Compatibility Re-export
 *
 * This file exists for backward compatibility.
 * The ModelHub component has been modularized into `src/components/model-hub/`.
 *
 * @deprecated Import from `@/components/model-hub` instead for new code.
 */

// Re-export the component as default and named export
export { default } from '@/components/model-hub/ModelHub';
export { default as ModelHub } from '@/components/model-hub/ModelHub';

// Re-export all types, hooks, and components for convenience
export * from '@/components/model-hub';
