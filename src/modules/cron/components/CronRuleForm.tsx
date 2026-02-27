'use client';

import React from 'react';
import type { UseCronRulesResult, CronRuleDraft } from '@/modules/cron/hooks/useCronRules';
import { CronTemplateSelector } from '@/modules/cron/components/CronTemplateSelector';

interface CronRuleFormProps {
  formMode: 'create' | 'edit' | null;
  draft: CronRuleDraft;
  validationErrors: UseCronRulesResult['validationErrors'];
  submitting: boolean;
  onUpdateDraft: UseCronRulesResult['actions']['updateDraft'];
  onSubmit: UseCronRulesResult['actions']['submitForm'];
  onCancel: UseCronRulesResult['actions']['cancelForm'];
}

export const CronRuleForm: React.FC<CronRuleFormProps> = ({
  formMode,
  draft,
  validationErrors,
  submitting,
  onUpdateDraft,
  onSubmit,
  onCancel,
}) => {
  const isEdit = formMode === 'edit';

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div>
          <h3 className="text-sm font-bold text-zinc-100">
            {isEdit ? 'Edit Rule' : 'Create Rule'}
          </h3>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            {isEdit
              ? 'Update the rule configuration below.'
              : 'Define a new scheduled automation rule.'}
          </p>
        </div>
        {isEdit && (
          <span className="rounded border border-indigo-700/40 bg-indigo-900/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-400">
            Editing
          </span>
        )}
      </header>

      <div className="space-y-4 p-4">
        {/* Templates (only in create mode) */}
        {!isEdit && (
          <CronTemplateSelector
            onApply={(patch) => {
              onUpdateDraft(patch);
            }}
          />
        )}

        {/* Form fields */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit();
          }}
          className="space-y-3"
          noValidate
        >
          {/* Name */}
          <FormField
            label="Name"
            htmlFor="cron-name"
            hint="A short, descriptive label for this rule."
            error={validationErrors.name}
            required
          >
            <input
              id="cron-name"
              type="text"
              value={draft.name}
              onChange={(e) => onUpdateDraft({ name: e.target.value })}
              placeholder="Morning Briefing"
              autoComplete="off"
              className={inputClass(!!validationErrors.name)}
            />
          </FormField>

          {/* Cron Expression */}
          <FormField
            label="Cron Expression"
            htmlFor="cron-expression"
            hint="Standard 5-field cron syntax (minute hour day month weekday)."
            error={validationErrors.cronExpression}
            required
          >
            <input
              id="cron-expression"
              type="text"
              value={draft.cronExpression}
              onChange={(e) => onUpdateDraft({ cronExpression: e.target.value })}
              placeholder="0 9 * * *"
              autoComplete="off"
              className={`font-mono ${inputClass(!!validationErrors.cronExpression)}`}
            />
          </FormField>

          {/* Timezone */}
          <FormField
            label="Timezone"
            htmlFor="cron-timezone"
            hint="IANA timezone identifier, e.g. UTC, Europe/Berlin."
          >
            <input
              id="cron-timezone"
              type="text"
              value={draft.timezone}
              onChange={(e) => onUpdateDraft({ timezone: e.target.value })}
              placeholder="UTC"
              autoComplete="off"
              className={inputClass(false)}
            />
          </FormField>

          {/* Prompt */}
          <FormField
            label="Prompt"
            htmlFor="cron-prompt"
            hint="The instruction sent to the AI agent when this rule fires."
            error={validationErrors.prompt}
            required
          >
            <textarea
              id="cron-prompt"
              value={draft.prompt}
              onChange={(e) => onUpdateDraft({ prompt: e.target.value })}
              rows={4}
              placeholder="Summarize overnight activity and highlight key priorities."
              className={`resize-y ${inputClass(!!validationErrors.prompt)}`}
            />
          </FormField>

          {/* Enabled toggle */}
          <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2.5 transition-colors hover:bg-zinc-800/30">
            <div className="relative">
              <input
                type="checkbox"
                id="cron-enabled"
                checked={draft.enabled}
                onChange={(e) => onUpdateDraft({ enabled: e.target.checked })}
                className="sr-only"
              />
              <div
                className={`h-5 w-9 rounded-full transition-colors ${draft.enabled ? 'bg-indigo-600' : 'bg-zinc-700'}`}
              />
              <div
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${draft.enabled ? 'translate-x-4' : 'translate-x-0.5'}`}
              />
            </div>
            <div>
              <span className="text-xs font-semibold text-zinc-200">
                {draft.enabled ? 'Enabled' : 'Disabled'}
              </span>
              <p className="text-[10px] text-zinc-500">
                {draft.enabled
                  ? 'Rule will fire on schedule.'
                  : 'Rule is paused and will not fire.'}
              </p>
            </div>
          </label>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white transition-all hover:bg-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Rule'}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-xs font-bold text-zinc-300 transition-all hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 disabled:opacity-60"
            >
              Reset
            </button>
          </div>
        </form>
      </div>
    </section>
  );
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function inputClass(hasError: boolean): string {
  return [
    'w-full rounded-lg border bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600',
    'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
    hasError
      ? 'border-rose-700/60 focus-visible:ring-rose-500'
      : 'border-zinc-700/60 hover:border-zinc-600',
  ].join(' ');
}

interface FormFieldProps {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}

const FormField: React.FC<FormFieldProps> = ({ label, htmlFor, hint, error, required, children }) => (
  <div className="space-y-1">
    <label htmlFor={htmlFor} className="flex items-center gap-1 text-xs font-semibold text-zinc-400">
      {label}
      {required && <span className="text-rose-400">*</span>}
    </label>
    {children}
    {hint && !error && <p className="text-[10px] text-zinc-600">{hint}</p>}
    {error && <p className="text-[10px] font-semibold text-rose-400">{error}</p>}
  </div>
);
