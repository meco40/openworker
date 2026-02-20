import { describe, expect, it } from 'vitest';
import { mapValidationMessageToFieldPath } from '@/shared/config/fieldMetadata';

describe('config editor conflict recovery semantics', () => {
  it('uses deterministic stale-revision message mapping', () => {
    const mapped = mapValidationMessageToFieldPath(
      'Config was changed by another session. Reload and review your changes.',
    );
    expect(mapped).toBeNull();
  });
});
