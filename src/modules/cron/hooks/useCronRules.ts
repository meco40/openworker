import { useCallback, useEffect, useRef, useState } from 'react';
import type { CronLeaseState, CronMetrics, CronRule, CronRun } from '@/modules/cron/types';

const RULE_LIMIT = 200;
const DEFAULT_HISTORY_LIMIT = 20;
const MIN_HISTORY_LIMIT = 1;
const MAX_HISTORY_LIMIT = 500;

type EditableCronField = 'name' | 'cronExpression' | 'prompt';

interface OkPayload {
  ok?: boolean;
  error?: string;
}

interface CronRulesPayload extends OkPayload {
  rules?: CronRule[];
}

interface CronRulePayload extends OkPayload {
  rule?: CronRule;
}

interface CronRunsPayload extends OkPayload {
  runs?: CronRun[];
}

interface CronRunPayload extends OkPayload {
  run?: CronRun;
}

interface CronMetricsPayload extends OkPayload {
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

function clampHistoryLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_HISTORY_LIMIT;
  }
  return Math.min(MAX_HISTORY_LIMIT, Math.max(MIN_HISTORY_LIMIT, Math.floor(value)));
}

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

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function resolveLeaseAgeSeconds(
  lease: Partial<CronLeaseState> | null | undefined,
  metrics: Partial<CronMetrics> | undefined,
): number | null {
  if (typeof metrics?.leaseAgeSeconds === 'number') {
    return Math.max(0, Math.round(metrics.leaseAgeSeconds));
  }

  const leaseTimestamp = lease?.heartbeatAt ?? lease?.updatedAt;
  if (!leaseTimestamp) {
    return null;
  }

  const ageMs = Date.now() - Date.parse(leaseTimestamp);
  if (!Number.isFinite(ageMs)) {
    return null;
  }
  return Math.max(0, Math.round(ageMs / 1000));
}

async function readJson<T extends OkPayload>(response: Response): Promise<T> {
  const payload = (await response.json()) as T;
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function fetchRules(): Promise<CronRule[]> {
  const response = await fetch(`/api/automations?limit=${RULE_LIMIT}`, { cache: 'no-store' });
  const payload = await readJson<CronRulesPayload>(response);
  return Array.isArray(payload.rules) ? payload.rules : [];
}

async function fetchMetrics(): Promise<CronMetrics> {
  const response = await fetch('/api/automations/metrics', { cache: 'no-store' });
  const payload = await readJson<CronMetricsPayload>(response);
  const metrics = payload.metrics || {};
  const lease = payload.leaseState ?? payload.lease;
  return {
    activeRules: typeof metrics.activeRules === 'number' ? metrics.activeRules : 0,
    queuedRuns: typeof metrics.queuedRuns === 'number' ? metrics.queuedRuns : 0,
    runningRuns: typeof metrics.runningRuns === 'number' ? metrics.runningRuns : 0,
    deadLetterRuns: typeof metrics.deadLetterRuns === 'number' ? metrics.deadLetterRuns : 0,
    leaseAgeSeconds: resolveLeaseAgeSeconds(lease, payload.metrics),
  };
}

async function fetchRuns(ruleId: string, limit: number): Promise<CronRun[]> {
  const response = await fetch(
    `/api/automations/${encodeURIComponent(ruleId)}/runs?limit=${clampHistoryLimit(limit)}`,
    {
      cache: 'no-store',
    },
  );
  const payload = await readJson<CronRunsPayload>(response);
  return Array.isArray(payload.runs) ? payload.runs : [];
}

export function useCronRules(): UseCronRulesResult {
  const [rules, setRules] = useState<CronRule[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [historyLimit, setHistoryLimit] = useState<number>(DEFAULT_HISTORY_LIMIT);
  const [metrics, setMetrics] = useState<CronMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<CronStatusMessage | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null);
  const [draft, setDraft] = useState<CronRuleDraft>(() => createCronRuleDraft());
  const [validationErrors, setValidationErrors] = useState<CronValidationErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [pendingRuleId, setPendingRuleId] = useState<string | null>(null);
  const editingRuleIdRef = useRef<string | null>(null);
  const hasLoadedRef = useRef(false);

  const refreshAll = useCallback(async () => {
    if (hasLoadedRef.current) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const [nextRules, nextMetrics] = await Promise.all([fetchRules(), fetchMetrics()]);
      setRules(nextRules);
      setMetrics(nextMetrics);
      setSelectedRuleId((previous) => {
        if (previous && nextRules.some((rule) => rule.id === previous)) {
          return previous;
        }
        return nextRules[0]?.id ?? null;
      });
      hasLoadedRef.current = true;
    } catch (loadError) {
      setError(getErrorMessage(loadError, 'Unable to load cron jobs.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!selectedRuleId) {
      setRuns([]);
      setHistoryError(null);
      return;
    }

    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);

    void fetchRuns(selectedRuleId, historyLimit)
      .then((nextRuns) => {
        if (!cancelled) {
          setRuns(nextRuns);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setHistoryError(getErrorMessage(loadError, 'Unable to load run history.'));
          setRuns([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [historyLimit, selectedRuleId]);

  const startCreate = useCallback(() => {
    editingRuleIdRef.current = null;
    setFormMode('create');
    setDraft(createCronRuleDraft());
    setValidationErrors({});
  }, []);

  const startEdit = useCallback((rule: CronRule) => {
    editingRuleIdRef.current = rule.id;
    setFormMode('edit');
    setDraft(createCronRuleDraft(rule));
    setValidationErrors({});
  }, []);

  const cancelForm = useCallback(() => {
    editingRuleIdRef.current = null;
    setFormMode(null);
    setDraft(createCronRuleDraft());
    setValidationErrors({});
  }, []);

  const updateDraft = useCallback((patch: Partial<CronRuleDraft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setValidationErrors((previous) => {
      if (!Object.keys(previous).length) {
        return previous;
      }
      const next = { ...previous };
      for (const key of Object.keys(patch)) {
        if (key === 'name' || key === 'cronExpression' || key === 'prompt') {
          delete next[key];
        }
      }
      return next;
    });
  }, []);

  const submitForm = useCallback(async () => {
    const nextErrors = validateCronRuleDraft(draft);
    if (Object.keys(nextErrors).length > 0) {
      setValidationErrors(nextErrors);
      return;
    }

    const isEdit = formMode === 'edit' && editingRuleIdRef.current;
    const targetRuleId = editingRuleIdRef.current;
    setSubmitting(true);
    setStatusMessage(null);
    try {
      if (isEdit && targetRuleId) {
        const response = await fetch(`/api/automations/${encodeURIComponent(targetRuleId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        });
        const payload = await readJson<CronRulePayload>(response);
        if (payload.rule) {
          setSelectedRuleId(payload.rule.id);
        }
        setStatusMessage({ tone: 'success', text: 'Cron job updated.' });
      } else {
        const response = await fetch('/api/automations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        });
        const payload = await readJson<CronRulePayload>(response);
        if (payload.rule) {
          setSelectedRuleId(payload.rule.id);
        }
        setStatusMessage({ tone: 'success', text: 'Cron job created.' });
      }

      cancelForm();
      await refreshAll();
    } catch (submitError) {
      setStatusMessage({
        tone: 'error',
        text: getErrorMessage(submitError, 'Failed to save cron job.'),
      });
    } finally {
      setSubmitting(false);
    }
  }, [cancelForm, draft, formMode, refreshAll]);

  const deleteRule = useCallback(
    async (ruleId: string) => {
      const targetRule = rules.find((rule) => rule.id === ruleId);
      const label = targetRule?.name ?? ruleId;
      if (typeof window !== 'undefined') {
        const confirmed = window.confirm(
          `Delete cron job "${label}"? This action cannot be undone.`,
        );
        if (!confirmed) {
          return;
        }
      }

      setPendingRuleId(ruleId);
      setStatusMessage(null);
      try {
        const response = await fetch(`/api/automations/${encodeURIComponent(ruleId)}`, {
          method: 'DELETE',
        });
        await readJson<OkPayload>(response);
        setStatusMessage({ tone: 'success', text: 'Cron job deleted.' });
        await refreshAll();
      } catch (deleteError) {
        setStatusMessage({
          tone: 'error',
          text: getErrorMessage(deleteError, 'Failed to delete cron job.'),
        });
      } finally {
        setPendingRuleId(null);
      }
    },
    [refreshAll, rules],
  );

  const toggleRule = useCallback(
    async (ruleId: string, enabled: boolean) => {
      setPendingRuleId(ruleId);
      setStatusMessage(null);
      try {
        const response = await fetch(`/api/automations/${encodeURIComponent(ruleId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
        await readJson<CronRulePayload>(response);
        setStatusMessage({
          tone: 'success',
          text: enabled ? 'Cron job enabled.' : 'Cron job paused.',
        });
        await refreshAll();
      } catch (toggleError) {
        setStatusMessage({
          tone: 'error',
          text: getErrorMessage(toggleError, 'Failed to update cron job state.'),
        });
      } finally {
        setPendingRuleId(null);
      }
    },
    [refreshAll],
  );

  const runNow = useCallback(
    async (ruleId: string) => {
      setPendingRuleId(ruleId);
      setStatusMessage(null);
      try {
        const response = await fetch(`/api/automations/${encodeURIComponent(ruleId)}/run`, {
          method: 'POST',
        });
        await readJson<CronRunPayload>(response);
        setStatusMessage({ tone: 'success', text: 'Manual run queued.' });
        await refreshAll();
        if (selectedRuleId === ruleId) {
          setHistoryLoading(true);
          try {
            const nextRuns = await fetchRuns(ruleId, historyLimit);
            setRuns(nextRuns);
            setHistoryError(null);
          } finally {
            setHistoryLoading(false);
          }
        }
      } catch (runError) {
        setStatusMessage({
          tone: 'error',
          text: getErrorMessage(runError, 'Failed to trigger run.'),
        });
      } finally {
        setPendingRuleId(null);
      }
    },
    [historyLimit, refreshAll, selectedRuleId],
  );

  return {
    rules,
    selectedRuleId,
    runs,
    historyLimit,
    metrics,
    loading,
    refreshing,
    error,
    statusMessage,
    historyLoading,
    historyError,
    formMode,
    draft,
    validationErrors,
    submitting,
    pendingRuleId,
    actions: {
      selectRule: setSelectedRuleId,
      startCreate,
      startEdit,
      cancelForm,
      updateDraft,
      submitForm,
      deleteRule,
      toggleRule,
      runNow,
      setHistoryLimit: (value: number) => {
        setHistoryLimit(clampHistoryLimit(value));
      },
      refreshAll,
    },
  };
}
