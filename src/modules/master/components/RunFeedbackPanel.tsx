import React, { useEffect, useRef, useState } from 'react';
import type { SubmitFeedbackInput } from '@/modules/master/api';

interface RunFeedbackPanelProps {
  runId: string;
  loading: boolean;
  onSubmit: (input: SubmitFeedbackInput) => Promise<{ ok: true } | { ok: false; error: string }>;
}

type PolicyOption = 'safe' | 'balanced' | 'fast';

const POLICY_LABELS: Record<PolicyOption, string> = {
  safe: 'Safe — conservative, no side-effects',
  balanced: 'Balanced — default behaviour',
  fast: 'Fast — aggressive, minimise latency',
};

export const RunFeedbackPanel: React.FC<RunFeedbackPanelProps> = ({ runId, loading, onSubmit }) => {
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [policy, setPolicy] = useState<PolicyOption>('balanced');
  const [comment, setComment] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submitInFlightRef = useRef(false);

  useEffect(() => {
    setRating(0);
    setHoverRating(0);
    setPolicy('balanced');
    setComment('');
    setSubmitted(false);
    setSubmitError(null);
    submitInFlightRef.current = false;
  }, [runId]);

  const handleSubmit = async () => {
    if (rating === 0 || loading || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setSubmitError(null);
    try {
      const result = await onSubmit({
        runId,
        rating,
        policy,
        comment: comment.trim() || undefined,
      });
      if (result.ok) {
        setSubmitted(true);
      } else {
        setSubmitError(result.error || 'Feedback konnte nicht gespeichert werden.');
      }
    } catch {
      setSubmitError('Feedback konnte nicht gespeichert werden.');
    } finally {
      submitInFlightRef.current = false;
    }
  };

  if (submitted) {
    return (
      <section className="overflow-hidden rounded-2xl border border-emerald-800/40 bg-emerald-900/10 shadow-xl">
        <div className="flex items-center gap-3 px-6 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/15">
            <svg
              className="h-4 w-4 text-emerald-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-emerald-300">Feedback submitted</p>
            <p className="text-xs text-emerald-500/70">Thank you for helping improve Master.</p>
          </div>
        </div>
      </section>
    );
  }

  const displayRating = hoverRating || rating;

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 shadow-xl">
      {/* Header */}
      <div className="border-b border-zinc-800/80 bg-zinc-950/40 px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500/15">
            <svg
              className="h-3.5 w-3.5 text-amber-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
              />
            </svg>
          </div>
          <h3 className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
            Rate This Run
          </h3>
        </div>
      </div>

      <div className="space-y-5 p-6">
        {/* Star rating */}
        <div className="space-y-2">
          <div className="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
            Rating
          </div>
          <div className="flex gap-2" role="group" aria-label="Star rating">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                aria-label={`${star} star${star !== 1 ? 's' : ''}`}
                onClick={() => setRating(star)}
                onMouseEnter={() => setHoverRating(star)}
                onMouseLeave={() => setHoverRating(0)}
                className={`text-2xl transition-all ${
                  star <= displayRating
                    ? 'scale-110 text-amber-400 drop-shadow-[0_0_6px_rgba(251,191,36,0.6)]'
                    : 'text-zinc-700 hover:text-amber-600'
                }`}
              >
                &#9733;
              </button>
            ))}
          </div>
          {rating === 0 && (
            <p className="text-[10px] text-zinc-600">Select a star rating to submit feedback.</p>
          )}
        </div>

        {/* Policy */}
        <label className="block space-y-1.5">
          <span className="block text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
            Preferred Policy
          </span>
          <select
            value={policy}
            onChange={(e) => setPolicy(e.target.value as PolicyOption)}
            className="w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100 transition-colors focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/30 focus:outline-none"
          >
            {(Object.keys(POLICY_LABELS) as PolicyOption[]).map((p) => (
              <option key={p} value={p}>
                {POLICY_LABELS[p]}
              </option>
            ))}
          </select>
        </label>

        {/* Comment */}
        <label className="block space-y-1.5">
          <span className="block text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
            Comment (optional)
          </span>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            className="w-full resize-none rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm leading-relaxed text-zinc-100 transition-colors focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/30 focus:outline-none"
            placeholder="What went well? What could improve?"
          />
        </label>

        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={loading || rating === 0}
          className="rounded-2xl bg-indigo-600 px-5 py-2.5 text-xs font-black tracking-widest text-white uppercase shadow-lg shadow-indigo-600/25 transition-all hover:bg-indigo-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <svg
                className="h-3 w-3 animate-spin"
                fill="none"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              Submitting…
            </span>
          ) : (
            'Submit Feedback'
          )}
        </button>
        {submitError && (
          <p className="rounded-xl border border-rose-700/40 bg-rose-900/25 px-3 py-2 text-xs text-rose-300">
            {submitError}
          </p>
        )}
      </div>
    </section>
  );
};
