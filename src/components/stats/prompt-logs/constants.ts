'use client';

import { PromptLogSummary, PromptLogDiagnostics } from './types';

export const PAGE_SIZE = 100;

export const EMPTY_SUMMARY: PromptLogSummary = {
  totalEntries: 0,
  flaggedEntries: 0,
  promptTokensTotal: 0,
  promptTokensExactCount: 0,
  promptTokensEstimatedCount: 0,
  totalCostUsd: 0,
};

export const EMPTY_DIAGNOSTICS: PromptLogDiagnostics = {
  loggerActive: true,
  attemptsSinceBoot: 0,
  writesSinceBoot: 0,
  lastAttemptAt: null,
  lastInsertAt: null,
  lastError: null,
  lastErrorAt: null,
};
