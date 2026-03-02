import { useCallback, useEffect, useRef, useState } from 'react';
import type { CronMetrics, CronRule, CronRun } from '@/modules/cron/types';
import {
  clampHistoryLimit,
  fetchMetrics,
  fetchRules,
  fetchRuns,
  getErrorMessage,
  readCronPayload,
} from '@/modules/cron/hooks/use-cron-rules/api';
import {
  clearDraftValidationErrors,
  createCronRuleDraft,
  validateCronRuleDraft,
} from '@/modules/cron/hooks/use-cron-rules/form';
import {
  DEFAULT_HISTORY_LIMIT,
  type CronRuleDraft,
  type CronRulePayload,
  type CronRunPayload,
  type CronStatusMessage,
  type CronValidationErrors,
  type OkPayload,
  type UseCronRulesResult,
} from '@/modules/cron/hooks/use-cron-rules/types';

export type {
  CronRuleDraft,
  CronStatusMessage,
  CronValidationErrors,
  UseCronRulesResult,
} from '@/modules/cron/hooks/use-cron-rules/types';
export {
  createCronRuleDraft,
  validateCronRuleDraft,
  clearDraftValidationErrors,
} from '@/modules/cron/hooks/use-cron-rules/form';

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
    setValidationErrors((previous) => clearDraftValidationErrors(previous, patch));
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
        const payload = await readCronPayload<CronRulePayload>(response);
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
        const payload = await readCronPayload<CronRulePayload>(response);
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
        await readCronPayload<OkPayload>(response);
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
        await readCronPayload<CronRulePayload>(response);
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
        await readCronPayload<CronRunPayload>(response);
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
