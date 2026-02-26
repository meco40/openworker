'use client';

import { PromptLogEntry } from '../types';

interface UseExportOptions {
  entries: PromptLogEntry[];
  filename?: string;
}

interface UseExportReturn {
  exportToJson: () => void;
  exportToCsv: () => void;
}

export function useExport({
  entries,
  filename = 'prompt-logs',
}: UseExportOptions): UseExportReturn {
  const exportToJson = () => {
    const dataStr = JSON.stringify(entries, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const exportToCsv = () => {
    if (entries.length === 0) return;

    const headers = [
      'ID',
      'Provider',
      'Model',
      'Dispatch Kind',
      'Prompt Tokens',
      'Completion Tokens',
      'Total Tokens',
      'Status',
      'Risk Level',
      'Risk Score',
      'Prompt Cost USD',
      'Total Cost USD',
      'Created At',
    ];

    const rows = entries.map((entry) => [
      entry.id,
      entry.providerId,
      entry.modelName,
      entry.dispatchKind,
      entry.promptTokens,
      entry.completionTokens,
      entry.totalTokens,
      entry.status,
      entry.riskLevel,
      entry.riskScore,
      entry.promptCostUsd ?? '',
      entry.totalCostUsd ?? '',
      entry.createdAt,
    ]);

    const csvContent = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
    const dataBlob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return { exportToJson, exportToCsv };
}
