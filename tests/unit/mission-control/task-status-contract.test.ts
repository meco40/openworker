import { describe, expect, it } from 'vitest';
import { CreateTaskSchema, UpdateTaskSchema } from '@/lib/validation';

describe('Mission Control task status contract', () => {
  it('accepts pending_dispatch in create schema', () => {
    const result = CreateTaskSchema.safeParse({
      title: 'Dispatch pending task',
      status: 'pending_dispatch',
      priority: 'normal',
    });

    expect(result.success).toBe(true);
  });

  it('accepts pending_dispatch in update schema', () => {
    const result = UpdateTaskSchema.safeParse({
      status: 'pending_dispatch',
    });

    expect(result.success).toBe(true);
  });
});
