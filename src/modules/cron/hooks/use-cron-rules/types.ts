import type { CronLeaseState, CronMetrics, CronRule, CronRun } from '@/modules/cron/types';

export const RULE_LIMIT = 200;
export const DEFAULT_HISTORY_LIMIT = 20;
export const MIN_HISTORY_LIMIT = 1;
export const MAX_HISTORY_LIMIT = 500;

export type EditableCronField = 'name' | 'cronExpression' | 'prompt';

export interface OkPayload {
  ok?: boolean;
  error?: string;
}

export interface CronRulesPayload extends OkPayload {
  rules?: CronRule[];
}

export interface CronRulePayload extends OkPayload {
  rule?: CronRule;
}

export interface CronRunsPayload extends OkPayload {
  runs?: CronRun[];
}

export interface CronRunPayload extends OkPayload {
  run?: CronRun;
}

export interface CronMetricsPayload extends OkPayload {
  metrics?: Partial<CronMetrics>;
  lease?: Partial<CronLeaseState> | null;
  leaseState?: Partial<CronLeaseState> | null;
}

export interface CronRuleDraft {
  name: string;
  cronExpression: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
}

export type CronValidationErrors = Partial<Record<EditableCronField, string>>;

export interface CronStatusMessage {
  tone: 'success' | 'error' | 'info';
  text: string;
}

export interface UseCronRulesResult {
  rules: CronRule[];
  selectedRuleId: string | null;
  runs: CronRun[];
  historyLimit: number;
  metrics: CronMetrics | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  statusMessage: CronStatusMessage | null;
  historyLoading: boolean;
  historyError: string | null;
  formMode: 'create' | 'edit' | null;
  draft: CronRuleDraft;
  validationErrors: CronValidationErrors;
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
