import React, { useState } from 'react';
import type { SubmitFeedbackInput } from '@/modules/master/api';

interface RunFeedbackPanelProps {
  runId: string;
  loading: boolean;
  onSubmit: (input: SubmitFeedbackInput) => void;
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

  const handleSubmit = () => {
    if (rating === 0) return;
    onSubmit({ runId, rating, policy, comment: comment.trim() || undefined });
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <section className="rounded-xl border border-emerald-800/40 bg-emerald-900/10 p-4">
        <div className="flex items-center gap-2 text-emerald-300">
          <svg
            className="h-4 w-4 shrink-0"
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
          <span className="text-xs font-semibold">Feedback submitted — thank you!</span>
        </div>
      </section>
    );
  }

  const displayRating = hoverRating || rating;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <h3 className="mb-4 text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
        Rate This Run
      </h3>

      <div className="space-y-4">
        {/* Star rating */}
        <div>
          <div className="mb-1.5 text-xs text-zinc-400">Rating</div>
          <div className="flex gap-1.5" role="group" aria-label="Star rating">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                aria-label={`${star} star${star !== 1 ? 's' : ''}`}
                onClick={() => setRating(star)}
                onMouseEnter={() => setHoverRating(star)}
                onMouseLeave={() => setHoverRating(0)}
                className={`text-xl transition-colors ${
                  star <= displayRating ? 'text-amber-400' : 'text-zinc-700'
                } hover:text-amber-400`}
              >
                ★
              </button>
            ))}
          </div>
        </div>

        {/* Policy */}
        <label className="block space-y-1.5 text-xs text-zinc-400">
          <span>Preferred Policy</span>
          <select
            value={policy}
            onChange={(e) => setPolicy(e.target.value as PolicyOption)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
          >
            {(Object.keys(POLICY_LABELS) as PolicyOption[]).map((p) => (
              <option key={p} value={p}>
                {POLICY_LABELS[p]}
              </option>
            ))}
          </select>
        </label>

        {/* Comment */}
        <label className="block space-y-1.5 text-xs text-zinc-400">
          <span>Comment (optional)</span>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
            placeholder="What went well? What could improve?"
          />
        </label>

        <button
          type="button"
          onClick={handleSubmit}
          disabled={loading || rating === 0}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-indigo-600/20 transition-all hover:bg-indigo-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Submitting…' : 'Submit Feedback'}
        </button>
      </div>
    </section>
  );
};
