'use client';

import React from 'react';
import { hasHighRiskDiff, type DiffItem } from '../../../src/shared/config/diffSummary';

interface DiffPreviewProps {
  diffItems: DiffItem[];
  onCancel: () => void;
  onConfirm: () => void;
}

function riskBadgeClass(risk: DiffItem['risk']): string {
  if (risk === 'restart-required')
    return 'bg-amber-500/20 text-amber-200 border border-amber-400/40';
  if (risk === 'sensitive') return 'bg-rose-500/20 text-rose-200 border border-rose-400/40';
  return 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/40';
}

export const DiffPreview: React.FC<DiffPreviewProps> = ({ diffItems, onCancel, onConfirm }) => {
  const hasHighRiskChanges = hasHighRiskDiff(diffItems);

  return (
    <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-4 py-3">
      <h4 className="mb-2 text-[10px] font-bold tracking-widest text-indigo-200 uppercase">
        Apply Preview
      </h4>
      {diffItems.length === 0 ? (
        <div className="text-xs text-zinc-400">No effective changes found.</div>
      ) : (
        <ul className="space-y-2 text-xs">
          {diffItems.map((item) => (
            <li key={item.path} className="flex items-center justify-between gap-3">
              <span className="font-mono text-zinc-200">{item.path}</span>
              <span
                className={`rounded px-2 py-0.5 text-[10px] uppercase ${riskBadgeClass(item.risk)}`}
              >
                {item.risk}
              </span>
            </li>
          ))}
        </ul>
      )}
      {hasHighRiskChanges && (
        <div className="mt-3 text-xs text-amber-200">
          This change contains high-risk fields. Confirm carefully.
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <button
          className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-200"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="rounded bg-indigo-700 px-3 py-1 text-xs text-white"
          onClick={onConfirm}
        >
          Confirm Apply
        </button>
      </div>
    </div>
  );
};
