import type { CronRule } from '@/modules/cron/types';
import type { CronRuleDraft, CronValidationErrors } from './types';

const VALIDATION_FIELDS = ['name', 'cronExpression', 'prompt'] as const;

export function createCronRuleDraft(rule?: CronRule | null): CronRuleDraft {
  if (!rule) {
    return {
      name: '',
      cronExpression: '',
      timezone: 'UTC',
      prompt: '',
      enabled: true,
    };
  }

  return {
    name: rule.name,
    cronExpression: rule.cronExpression,
    timezone: rule.timezone,
    prompt: rule.prompt,
    enabled: rule.enabled,
  };
}

export function validateCronRuleDraft(draft: CronRuleDraft): CronValidationErrors {
  const errors: CronValidationErrors = {};
  if (!draft.name.trim()) {
    errors.name = 'Name is required.';
  }
  if (!draft.cronExpression.trim()) {
    errors.cronExpression = 'Cron expression is required.';
  }
  if (!draft.prompt.trim()) {
    errors.prompt = 'Prompt is required.';
  }
  return errors;
}

export function clearDraftValidationErrors(
  previousErrors: CronValidationErrors,
  patch: Partial<CronRuleDraft>,
): CronValidationErrors {
  if (Object.keys(previousErrors).length === 0) {
    return previousErrors;
  }

  const next = { ...previousErrors };
  for (const key of Object.keys(patch)) {
    if (VALIDATION_FIELDS.includes(key as (typeof VALIDATION_FIELDS)[number])) {
      delete next[key as keyof CronValidationErrors];
    }
  }
  return next;
}
