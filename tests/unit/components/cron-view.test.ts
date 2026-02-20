import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CronView from '@/modules/cron/components/CronView';
import {
  createCronRuleDraft,
  validateCronRuleDraft,
  type CronRuleDraft,
} from '@/modules/cron/hooks/useCronRules';
import type { CronMetrics, CronRule, CronRun } from '@/modules/cron/types';

interface CronViewTestState {
  rules: CronRule[];
  selectedRuleId: string | null;
  runs: CronRun[];
  historyLimit: number;
  metrics: CronMetrics | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  statusMessage: { tone: 'success' | 'error' | 'info'; text: string } | null;
  historyLoading: boolean;
  historyError: string | null;
  formMode: 'create' | 'edit' | null;
  draft: CronRuleDraft;
  validationErrors: Partial<Record<'name' | 'cronExpression' | 'prompt', string>>;
  submitting: boolean;
  pendingRuleId: string | null;
  actions: {
    selectRule: (ruleId: string) => void;
    startCreate: () => void;
    startEdit: (rule: CronRule) => void;
    cancelForm: () => void;
    updateDraft: (patch: Partial<CronRuleDraft>) => void;
    submitForm: () => Promise<void>;
    deleteRule: (ruleId: string) => Promise<void>;
    toggleRule: (ruleId: string, enabled: boolean) => Promise<void>;
    runNow: (ruleId: string) => Promise<void>;
    setHistoryLimit: (value: number) => void;
    refreshAll: () => Promise<void>;
  };
}

const noop = () => {};
const asyncNoop = async () => {};

function buildState(partial: Partial<CronViewTestState> = {}): CronViewTestState {
  return {
    rules: [],
    selectedRuleId: null,
    runs: [],
    historyLimit: 20,
    metrics: {
      activeRules: 0,
      queuedRuns: 0,
      runningRuns: 0,
      deadLetterRuns: 0,
      leaseAgeSeconds: null,
    },
    loading: false,
    refreshing: false,
    error: null,
    statusMessage: null,
    historyLoading: false,
    historyError: null,
    formMode: null,
    draft: createCronRuleDraft(),
    validationErrors: {},
    submitting: false,
    pendingRuleId: null,
    actions: {
      selectRule: noop,
      startCreate: noop,
      startEdit: noop,
      cancelForm: noop,
      updateDraft: noop,
      submitForm: asyncNoop,
      deleteRule: asyncNoop,
      toggleRule: asyncNoop,
      runNow: asyncNoop,
      setHistoryLimit: noop,
      refreshAll: asyncNoop,
    },
    ...partial,
  };
}

describe('CronView', () => {
  it('renders loading and empty states', () => {
    const loadingHtml = renderToStaticMarkup(
      createElement(CronView, { state: buildState({ loading: true }) }),
    );
    const emptyHtml = renderToStaticMarkup(createElement(CronView, { state: buildState() }));

    expect(loadingHtml).toContain('Loading cron rules...');
    expect(emptyHtml).toContain('No cron jobs yet');
  });

  it('renders rules list content when data exists', () => {
    const rules: CronRule[] = [
      {
        id: 'rule-1',
        userId: 'user-1',
        name: 'Morning Briefing',
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
        prompt: 'Generate a briefing.',
        enabled: true,
        nextRunAt: '2026-02-21T09:00:00.000Z',
        lastRunAt: null,
        consecutiveFailures: 0,
        lastError: null,
        createdAt: '2026-02-20T00:00:00.000Z',
        updatedAt: '2026-02-20T00:00:00.000Z',
      },
    ];
    const html = renderToStaticMarkup(
      createElement(CronView, {
        state: buildState({ rules, selectedRuleId: 'rule-1' }),
      }),
    );

    expect(html).toContain('Morning Briefing');
    expect(html).toContain('0 9 * * *');
    expect(html).toContain('UTC');
  });

  it('renders a run history depth control for operators', () => {
    const html = renderToStaticMarkup(createElement(CronView, { state: buildState() }));
    expect(html).toContain('Run history depth');
  });

  it('validates required rule form fields', () => {
    const errors = validateCronRuleDraft({
      name: '',
      cronExpression: '',
      timezone: 'UTC',
      prompt: '',
      enabled: true,
    });

    expect(errors.name).toBeDefined();
    expect(errors.cronExpression).toBeDefined();
    expect(errors.prompt).toBeDefined();
  });

  it('prefills draft in edit mode from an existing rule', () => {
    const draft = createCronRuleDraft({
      id: 'rule-2',
      userId: 'user-1',
      name: 'Evening Digest',
      cronExpression: '0 19 * * *',
      timezone: 'Europe/Berlin',
      prompt: 'Send an evening digest.',
      enabled: false,
      nextRunAt: null,
      lastRunAt: null,
      consecutiveFailures: 0,
      lastError: null,
      createdAt: '2026-02-20T00:00:00.000Z',
      updatedAt: '2026-02-20T00:00:00.000Z',
    });

    expect(draft).toEqual({
      name: 'Evening Digest',
      cronExpression: '0 19 * * *',
      timezone: 'Europe/Berlin',
      prompt: 'Send an evening digest.',
      enabled: false,
    });
  });
});
