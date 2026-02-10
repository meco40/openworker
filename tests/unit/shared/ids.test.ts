import { describe, expect, it } from 'vitest';
import { createId } from '../../../src/shared/lib/ids';

describe('createId', () => {
  it('creates prefixed ids', () => {
    expect(createId('msg')).toMatch(/^msg-/);
  });
});
