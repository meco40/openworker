import { useState, useEffect, useCallback, useRef } from 'react';
import type { PlanningSessionState, PlanningTabProps } from './types';

interface PlanningSubmission {
  answer: string;
  otherText?: string;
}

export interface PlanningTabController {
  state: PlanningSessionState | null;
  loading: boolean;
  starting: boolean;
  submitting: boolean;
  canceling: boolean;
  error: string | null;
  otherText: string;
  selectedOption: string | null;
  isWaitingForResponse: boolean;
  retryingDispatch: boolean;
  isSubmittingAnswer: boolean;
  isRefreshingFallback: boolean;
  fallbackRefreshError: string | null;
  hasRetrySubmission: boolean;
  setOtherText: (value: string) => void;
  setSelectedOption: (value: string | null) => void;
  startPlanning: () => Promise<void>;
  submitAnswer: () => Promise<void>;
  handleRetry: () => Promise<void>;
  retryDispatch: () => Promise<void>;
  triggerFallbackRefresh: () => Promise<void>;
  cancelPlanning: () => Promise<void>;
}

export function usePlanningTabController({
  taskId,
  onPlanningComplete,
  onFallbackRefresh,
}: PlanningTabProps): PlanningTabController {
  const [state, setState] = useState<PlanningSessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otherText, setOtherText] = useState('');
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);
  const [retryingDispatch, setRetryingDispatch] = useState(false);
  const [isSubmittingAnswer, setIsSubmittingAnswer] = useState(false);
  const [isRefreshingFallback, setIsRefreshingFallback] = useState(false);
  const [fallbackRefreshError, setFallbackRefreshError] = useState<string | null>(null);

  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isPollingRef = useRef(false);
  const lastSubmissionRef = useRef<PlanningSubmission | null>(null);
  const currentQuestionRef = useRef<string | null>(null);
  const completionCallbackSentRef = useRef(false);

  const notifyPlanningComplete = useCallback(
    async (dispatchError?: string) => {
      if (completionCallbackSentRef.current) return;
      completionCallbackSentRef.current = true;
      if (!onPlanningComplete) return;
      try {
        await onPlanningComplete({ taskId, dispatchError });
      } catch (completionError) {
        console.error('Planning completion callback failed:', completionError);
      }
    },
    [onPlanningComplete, taskId],
  );

  const loadState = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/planning`);
      if (res.ok) {
        const data = await res.json();
        setState(data);
        currentQuestionRef.current = data.currentQuestion?.question ?? null;
      }
    } catch (err) {
      console.error('Failed to load planning state:', err);
      setError('Failed to load planning state');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current);
      pollingTimeoutRef.current = null;
    }
    setIsWaitingForResponse(false);
  }, []);

  const pollForUpdates = useCallback(async () => {
    if (isPollingRef.current) return;
    isPollingRef.current = true;

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/poll`);
      if (res.ok) {
        const data = await res.json();
        const pollSignalsCompletion = Boolean(
          data.complete || data.isComplete || data.dispatchError,
        );

        if (!data.hasUpdates && data.isComplete) {
          setState((prev) =>
            prev
              ? {
                  ...prev,
                  isComplete: true,
                  currentQuestion: undefined,
                  dispatchError: data.dispatchError ?? prev.dispatchError,
                }
              : prev,
          );

          setSubmitting(false);
          setIsSubmittingAnswer(false);
          setSelectedOption(null);
          setOtherText('');
          setIsWaitingForResponse(false);
          stopPolling();

          await notifyPlanningComplete(data.dispatchError);
          return;
        }

        if (data.hasUpdates) {
          const newQuestion = data.currentQuestion?.question;
          const questionChanged = newQuestion && currentQuestionRef.current !== newQuestion;

          setState((prev) => ({
            ...(prev ?? { taskId, isStarted: true, messages: [], isComplete: false }),
            messages: data.messages ?? prev?.messages ?? [],
            isComplete: Boolean(data.complete || data.isComplete || data.dispatchError),
            spec: data.spec ?? prev?.spec,
            agents: data.agents ?? prev?.agents,
            dispatchError: data.dispatchError ?? prev?.dispatchError,
            currentQuestion:
              data.currentQuestion ?? (pollSignalsCompletion ? undefined : prev?.currentQuestion),
          }));

          if (questionChanged) {
            currentQuestionRef.current = newQuestion ?? null;
            setSelectedOption(null);
            setOtherText('');
            setIsSubmittingAnswer(false);
          }

          if (data.currentQuestion) {
            setIsSubmittingAnswer(false);
            setSubmitting(false);
          }

          if (data.dispatchError) {
            setError(`Planning completed but dispatch failed: ${data.dispatchError}`);
          }

          if (pollSignalsCompletion) {
            await notifyPlanningComplete(data.dispatchError);
          }

          if (data.currentQuestion || pollSignalsCompletion) {
            setSubmitting(false);
            setIsSubmittingAnswer(false);
            if (pollSignalsCompletion) {
              setSelectedOption(null);
              setOtherText('');
            }
            setIsWaitingForResponse(false);
            stopPolling();
          }
        }
      }
    } catch (err) {
      console.error('Failed to poll for updates:', err);
    } finally {
      isPollingRef.current = false;
    }
  }, [taskId, notifyPlanningComplete, stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    setIsWaitingForResponse(true);

    pollingIntervalRef.current = setInterval(() => {
      pollForUpdates();
    }, 2000);

    pollingTimeoutRef.current = setTimeout(() => {
      stopPolling();
      setSubmitting(false);
      setIsSubmittingAnswer(false);
      setError(
        'The orchestrator is taking too long to respond. Please try submitting again or use Neu laden.',
      );
    }, 90000);
  }, [pollForUpdates, stopPolling]);

  useEffect(() => {
    if (state?.currentQuestion) {
      currentQuestionRef.current = state.currentQuestion.question;
    }
  }, [state]);

  useEffect(() => {
    loadState();
    return () => stopPolling();
  }, [loadState, stopPolling]);

  useEffect(() => {
    if (
      state &&
      state.isStarted &&
      !state.isComplete &&
      !state.currentQuestion &&
      !isWaitingForResponse
    ) {
      startPolling();
    }
  }, [state, isWaitingForResponse, startPolling]);

  const startPlanning = async () => {
    setStarting(true);
    setError(null);
    completionCallbackSentRef.current = false;

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning`, { method: 'POST' });
      const data = await res.json();

      if (res.ok) {
        setState((prev) => ({
          ...prev!,
          sessionKey: data.sessionKey,
          messages: data.messages || [],
          isStarted: true,
        }));
        startPolling();
      } else {
        setError(data.error || 'Failed to start planning');
      }
    } catch {
      setError('Failed to start planning');
    } finally {
      setStarting(false);
    }
  };

  const submitPlanningAnswer = async (submission: PlanningSubmission): Promise<boolean> => {
    setSubmitting(true);
    setIsSubmittingAnswer(true);
    setError(null);
    let accepted = false;
    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
      });

      const data = await res.json();

      if (res.ok) {
        startPolling();
        accepted = true;
        return true;
      }
      setError(data.error || 'Failed to submit answer');
      return false;
    } catch {
      setError('Failed to submit answer');
      return false;
    } finally {
      if (!accepted) {
        setSubmitting(false);
        setIsSubmittingAnswer(false);
      }
    }
  };

  const resetAnswerControls = useCallback(() => {
    setIsSubmittingAnswer(false);
    setSelectedOption(null);
    setOtherText('');
  }, []);

  const submitAnswer = async () => {
    if (!selectedOption) return;

    const submission: PlanningSubmission = {
      answer: selectedOption?.toLowerCase() === 'other' ? 'other' : selectedOption,
      otherText: selectedOption?.toLowerCase() === 'other' ? otherText : undefined,
    };
    lastSubmissionRef.current = submission;

    const success = await submitPlanningAnswer(submission);
    if (!success) {
      resetAnswerControls();
    }
  };

  const handleRetry = async () => {
    const submission = lastSubmissionRef.current;
    if (!submission) return;

    const success = await submitPlanningAnswer(submission);
    if (!success) {
      resetAnswerControls();
    }
  };

  const retryDispatch = async () => {
    setRetryingDispatch(true);
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/retry-dispatch`, {
        method: 'POST',
      });

      const data = await res.json();

      if (res.ok) {
        console.log('Dispatch retry successful:', data.message);
        setError(null);
      } else {
        setError(`Failed to retry dispatch: ${data.error}`);
      }
    } catch {
      setError('Failed to retry dispatch');
    } finally {
      setRetryingDispatch(false);
    }
  };

  const triggerFallbackRefresh = async () => {
    if (!onFallbackRefresh) return;
    setIsRefreshingFallback(true);
    setFallbackRefreshError(null);
    try {
      await onFallbackRefresh();
    } catch (refreshError) {
      const message =
        refreshError instanceof Error
          ? refreshError.message
          : 'Neu laden fehlgeschlagen. Bitte erneut versuchen.';
      setFallbackRefreshError(message);
    } finally {
      setIsRefreshingFallback(false);
    }
  };

  const cancelPlanning = async () => {
    if (!confirm('Are you sure you want to cancel planning? This will reset the planning state.')) {
      return;
    }

    setCanceling(true);
    setError(null);
    setIsSubmittingAnswer(false);
    stopPolling();

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning`, {
        method: 'DELETE',
      });

      if (res.ok) {
        completionCallbackSentRef.current = false;
        setState({
          taskId,
          isStarted: false,
          messages: [],
          isComplete: false,
        });
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to cancel planning');
      }
    } catch {
      setError('Failed to cancel planning');
    } finally {
      setCanceling(false);
    }
  };

  return {
    state,
    loading,
    starting,
    submitting,
    canceling,
    error,
    otherText,
    selectedOption,
    isWaitingForResponse,
    retryingDispatch,
    isSubmittingAnswer,
    isRefreshingFallback,
    fallbackRefreshError,
    hasRetrySubmission: Boolean(lastSubmissionRef.current),
    setOtherText,
    setSelectedOption,
    startPlanning,
    submitAnswer,
    handleRetry,
    retryDispatch,
    triggerFallbackRefresh,
    cancelPlanning,
  };
}
