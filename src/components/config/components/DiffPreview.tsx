'use client';

import React from 'react';
import { hasHighRiskDiff, type DiffItem } from '@/shared/config/diffSummary';

interface DiffPreviewProps {
  diffItems: DiffItem[];
  onCancel: () => void;
  onConfirm: () => void;
}

function riskBadgeClass(risk: DiffItem['risk']): string {
  if (risk === 'restart-required')
    return 'bg-amber-900/50 text-amber-300 border border-amber-700/40';
  if (risk === 'sensitive') return 'bg-red-900/50 text-red-300 border border-red-700/40';
  return 'bg-emerald-900/40 text-emerald-300 border border-emerald-800/40';
}

function riskIcon(risk: DiffItem['risk']): React.ReactNode {
  if (risk === 'restart-required')
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-3 w-3 text-amber-400"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
          clipRule="evenodd"
        />
      </svg>
    );
  if (risk === 'sensitive')
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-3 w-3 text-red-400"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z"
          clipRule="evenodd"
        />
      </svg>
    );
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-3 w-3 text-emerald-400"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export const DiffPreview: React.FC<DiffPreviewProps> = ({ diffItems, onCancel, onConfirm }) => {
  const hasHighRiskChanges = hasHighRiskDiff(diffItems);

  return (
    <div
      role="region"
      aria-label="Apply preview"
      className="rounded-xl border border-indigo-700/40 bg-indigo-950/30 px-4 py-4"
    >
      {/* Header */}
      <div className="mb-3 flex items-center gap-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4 text-indigo-400"
          aria-hidden="true"
        >
          <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
          <path
            fillRule="evenodd"
            d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z"
            clipRule="evenodd"
          />
        </svg>
        <h4 className="text-xs font-semibold text-indigo-200">Apply Preview</h4>
        <span className="ml-auto rounded-full bg-indigo-900/60 px-2 py-0.5 text-[10px] text-indigo-300">
          {diffItems.length} change{diffItems.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Diff list */}
      {diffItems.length === 0 ? (
        <p className="text-xs text-zinc-500">No effective changes found.</p>
      ) : (
        <ul className="mb-3 space-y-1.5">
          {diffItems.map((item) => (
            <li
              key={item.path}
              className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/60 bg-zinc-900/60 px-3 py-2"
            >
              <span className="flex items-center gap-1.5 font-mono text-xs text-zinc-300">
                {riskIcon(item.risk)}
                {item.path}
              </span>
              <span
                className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${riskBadgeClass(item.risk)}`}
              >
                {item.risk}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* High-risk warning */}
      {hasHighRiskChanges && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-800/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="mt-px h-4 w-4 shrink-0 text-amber-400"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
              clipRule="evenodd"
            />
          </svg>
          High-risk changes detected. A gateway restart may be required. Confirm carefully.
        </div>
      )}

      {/* Actions */}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          Confirm Apply
        </button>
      </div>
    </div>
  );
};
