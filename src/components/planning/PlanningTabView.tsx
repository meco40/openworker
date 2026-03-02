import { AlertCircle, CheckCircle, Loader2, Lock, X } from 'lucide-react';
import type { PlanningSessionState } from './types';

interface PlanningTabViewProps {
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
  hasRetrySubmission: boolean;
  onOtherTextChange: (value: string) => void;
  onSelectOption: (value: string | null) => void;
  onStartPlanning: () => Promise<void>;
  onSubmitAnswer: () => Promise<void>;
  onRetry: () => Promise<void>;
  onRetryDispatch: () => Promise<void>;
  onCancelPlanning: () => Promise<void>;
}

export function PlanningTabView({
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
  hasRetrySubmission,
  onOtherTextChange,
  onSelectOption,
  onStartPlanning,
  onSubmitAnswer,
  onRetry,
  onRetryDispatch,
  onCancelPlanning,
}: PlanningTabViewProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="text-mc-accent h-6 w-6 animate-spin" />
        <span className="text-mc-text-secondary ml-2">Loading planning state...</span>
      </div>
    );
  }

  if (state?.isComplete && state?.spec) {
    return (
      <div className="space-y-6 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-green-400">
            <Lock className="h-5 w-5" />
            <span className="font-medium">Planning Complete</span>
          </div>
          {state.dispatchError && (
            <div className="text-right">
              <span className="text-sm text-amber-400">⚠️ Dispatch Failed</span>
            </div>
          )}
        </div>

        {state.dispatchError && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
              <div className="flex-1">
                <p className="mb-2 text-sm font-medium text-amber-400">Task dispatch failed</p>
                <p className="mb-3 text-xs text-amber-300">{state.dispatchError}</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={onRetryDispatch}
                    disabled={retryingDispatch}
                    className="flex items-center gap-1 rounded bg-amber-500/20 px-3 py-1 text-xs text-amber-300 hover:bg-amber-500/30 disabled:opacity-50"
                  >
                    {retryingDispatch ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Retrying...
                      </>
                    ) : (
                      <>
                        <CheckCircle className="h-3 w-3" />
                        Retry Dispatch
                      </>
                    )}
                  </button>
                  <span className="text-xs text-amber-400">
                    This will attempt to assign the task to an agent
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="bg-mc-bg border-mc-border rounded-lg border p-4">
          <h3 className="mb-2 font-medium">{state.spec.title}</h3>
          <p className="text-mc-text-secondary mb-4 text-sm">{state.spec.summary}</p>

          {state.spec.deliverables?.length > 0 && (
            <div className="mb-3">
              <h4 className="mb-1 text-sm font-medium">Deliverables:</h4>
              <ul className="text-mc-text-secondary list-inside list-disc text-sm">
                {state.spec.deliverables.map((deliverable, index) => (
                  <li key={index}>{deliverable}</li>
                ))}
              </ul>
            </div>
          )}

          {state.spec.success_criteria?.length > 0 && (
            <div>
              <h4 className="mb-1 text-sm font-medium">Success Criteria:</h4>
              <ul className="text-mc-text-secondary list-inside list-disc text-sm">
                {state.spec.success_criteria.map((criterion, index) => (
                  <li key={index}>{criterion}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {state.agents && state.agents.length > 0 && (
          <div>
            <h3 className="mb-2 font-medium">Agents Created:</h3>
            <div className="space-y-2">
              {state.agents.map((agent, index) => (
                <div
                  key={index}
                  className="bg-mc-bg border-mc-border flex items-center gap-3 rounded-lg border p-3"
                >
                  <span className="text-2xl">{agent.avatar_emoji}</span>
                  <div>
                    <p className="font-medium">{agent.name}</p>
                    <p className="text-mc-text-secondary text-sm">{agent.role}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (!state?.isStarted) {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 p-8">
        <div className="text-center">
          <h3 className="mb-2 text-lg font-medium">Start Planning</h3>
          <p className="text-mc-text-secondary max-w-md text-sm">
            I&apos;ll ask you a few questions to understand exactly what you need. All questions are
            multiple choice — just click to answer.
          </p>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-400">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        <button
          onClick={onStartPlanning}
          disabled={starting}
          className="bg-mc-accent text-mc-bg hover:bg-mc-accent/90 flex items-center gap-2 rounded-lg px-6 py-3 font-medium disabled:opacity-50"
        >
          {starting ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" />
              Starting...
            </>
          ) : (
            <>📋 Start Planning</>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-mc-border flex items-center justify-between border-b p-4">
        <div className="text-mc-text-secondary flex items-center gap-2 text-sm">
          <div className="h-2 w-2 animate-pulse rounded-full bg-purple-500" />
          <span>Planning in progress...</span>
        </div>
        <button
          onClick={onCancelPlanning}
          disabled={canceling}
          className="text-mc-accent-red hover:bg-mc-accent-red/10 flex items-center gap-2 rounded px-3 py-2 text-sm disabled:opacity-50"
        >
          {canceling ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Canceling...
            </>
          ) : (
            <>
              <X className="h-4 w-4" />
              Cancel
            </>
          )}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {state?.currentQuestion ? (
          <div className="mx-auto max-w-xl">
            <h3 className="mb-6 text-lg font-medium">{state.currentQuestion.question}</h3>

            <div className="space-y-3">
              {state.currentQuestion.options.map((option) => {
                const isSelected = selectedOption === option.label;
                const isOther = option.id === 'other' || option.label.toLowerCase() === 'other';
                const isThisOptionSubmitting = isSubmittingAnswer && isSelected;

                return (
                  <div key={option.id}>
                    <button
                      onClick={() => onSelectOption(option.label)}
                      disabled={submitting}
                      className={`flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-all ${
                        isThisOptionSubmitting
                          ? 'border-mc-accent bg-mc-accent/20'
                          : isSelected
                            ? 'border-mc-accent bg-mc-accent/10'
                            : 'border-mc-border hover:border-mc-accent/50'
                      } disabled:opacity-50`}
                    >
                      <span
                        className={`flex h-8 w-8 items-center justify-center rounded text-sm font-bold ${
                          isSelected ? 'bg-mc-accent text-mc-bg' : 'bg-mc-bg-tertiary'
                        }`}
                      >
                        {option.id.toUpperCase()}
                      </span>
                      <span className="flex-1">{option.label}</span>
                      {isThisOptionSubmitting ? (
                        <Loader2 className="text-mc-accent h-5 w-5 animate-spin" />
                      ) : isSelected && !submitting ? (
                        <CheckCircle className="text-mc-accent h-5 w-5" />
                      ) : null}
                    </button>

                    {isOther && isSelected && (
                      <div className="mt-2 ml-11">
                        <input
                          type="text"
                          value={otherText}
                          onChange={(event) => onOtherTextChange(event.target.value)}
                          placeholder="Please specify..."
                          className="bg-mc-bg border-mc-border focus:border-mc-accent w-full rounded border px-3 py-2 text-sm focus:outline-none"
                          disabled={submitting}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {error && (
              <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-400" />
                  <div className="flex-1">
                    <p className="text-sm text-red-400">{error}</p>
                    {!isWaitingForResponse && hasRetrySubmission && (
                      <button
                        onClick={onRetry}
                        disabled={submitting}
                        className="mt-2 text-xs text-red-400 underline hover:text-red-300 disabled:opacity-50"
                      >
                        {submitting ? 'Retrying...' : 'Retry'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="mt-6">
              <button
                onClick={onSubmitAnswer}
                disabled={
                  !selectedOption || submitting || (selectedOption === 'Other' && !otherText.trim())
                }
                className="bg-mc-accent text-mc-bg hover:bg-mc-accent/90 flex w-full items-center justify-center gap-2 rounded-lg px-6 py-3 font-medium disabled:opacity-50"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Sending...
                  </>
                ) : (
                  'Continue →'
                )}
              </button>

              {isSubmittingAnswer && !submitting && (
                <div className="text-mc-text-secondary mt-4 flex items-center justify-center gap-2 text-sm">
                  <Loader2 className="text-mc-accent h-4 w-4 animate-spin" />
                  <span>Waiting for response...</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <Loader2 className="text-mc-accent mx-auto mb-2 h-8 w-8 animate-spin" />
              <p className="text-mc-text-secondary">
                {isWaitingForResponse ? 'Waiting for response...' : 'Waiting for next question...'}
              </p>
            </div>
          </div>
        )}
      </div>

      {state?.messages && state.messages.length > 0 && (
        <details className="border-mc-border border-t">
          <summary className="text-mc-text-secondary hover:bg-mc-bg-tertiary cursor-pointer p-3 text-sm">
            View conversation ({state.messages.length} messages)
          </summary>
          <div className="bg-mc-bg max-h-48 space-y-2 overflow-y-auto p-3">
            {state.messages.map((msg, index) => (
              <div
                key={index}
                className={`text-sm ${msg.role === 'user' ? 'text-mc-accent' : 'text-mc-text-secondary'}`}
              >
                <span className="font-medium">{msg.role === 'user' ? 'You' : 'Orchestrator'}:</span>{' '}
                <span className="opacity-75">{msg.content.substring(0, 100)}...</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
