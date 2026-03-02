import { describe, expect, it } from 'vitest';
import {
  clearDraftValidationErrors,
  createCronRuleDraft,
  validateCronRuleDraft,
} from '@/modules/cron/hooks/use-cron-rules/form';
import type { CronValidationErrors } from '@/modules/cron/hooks/use-cron-rules/types';

describe('use-cron-rules form helpers', () => {
  it('builds default draft values when no rule is provided', () => {
    expect(createCronRuleDraft()).toEqual({
      name: '',
      cronExpression: '',
      timezone: 'UTC',
      prompt: '',
      enabled: true,
    });
  });

  it('validates required editable fields', () => {
    const errors = validateCronRuleDraft({
      name: ' ',
      cronExpression: '',
      timezone: 'UTC',
      prompt: ' ',
      enabled: true,
    });

    expect(errors).toEqual({
      name: 'Name is required.',
      cronExpression: 'Cron expression is required.',
      prompt: 'Prompt is required.',
    });
  });

  it('clears only validation keys touched by a patch', () => {
    const previousErrors: CronValidationErrors = {
      name: 'Name is required.',
      cronExpression: 'Cron expression is required.',
      prompt: 'Prompt is required.',
    };

    expect(
      clearDraftValidationErrors(previousErrors, { name: 'Daily digest', enabled: false }),
    ).toEqual({
      cronExpression: 'Cron expression is required.',
      prompt: 'Prompt is required.',
    });
  });
});
