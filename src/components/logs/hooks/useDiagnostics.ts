'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  DIAGNOSTICS_REFRESH_INTERVAL_MS,
  MEMORY_DIAGNOSTICS_STORAGE_KEY,
  extractDoctorFindingDetails,
  extractHealthIssues,
  parseDiagnosticsStatus,
  summarizeHealthChecks,
  toHealthDiagnosticsStatus,
  type DoctorApiResponse,
  type DoctorDiagnosticsState,
  type HealthDiagnosticsState,
} from '@/components/logs/diagnostics';

export function useDiagnostics() {
  const [healthDiagnostics, setHealthDiagnostics] = useState<HealthDiagnosticsState>({
    status: 'unknown',
    summary: null,
    issues: [],
    generatedAt: null,
    error: null,
  });
  const [doctorDiagnostics, setDoctorDiagnostics] = useState<DoctorDiagnosticsState>({
    status: 'unknown',
    findingsCount: 0,
    recommendationsCount: 0,
    findingDetails: [],
    recommendations: [],
    generatedAt: null,
    error: null,
  });
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(true);
  const [memoryDiagnosticsEnabled, setMemoryDiagnosticsEnabled] = useState(false);

  // Load memory diagnostics setting from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(MEMORY_DIAGNOSTICS_STORAGE_KEY);
      if (stored === '1' || stored === 'true') {
        setMemoryDiagnosticsEnabled(true);
      }
    } catch {
      // Ignore storage access errors (SSR/private mode edge cases)
    }
  }, []);

  // Save memory diagnostics setting to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(MEMORY_DIAGNOSTICS_STORAGE_KEY, memoryDiagnosticsEnabled ? '1' : '0');
    } catch {
      // Ignore storage access errors.
    }
  }, [memoryDiagnosticsEnabled]);

  const fetchDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);
    const memoryDiagnosticsFlag = memoryDiagnosticsEnabled ? '1' : '0';
    try {
      const response = await fetch(`/api/doctor?memoryDiagnostics=${memoryDiagnosticsFlag}`);
      const payload = (await response.json()) as DoctorApiResponse;

      if (!response.ok || payload.ok === false) {
        const error = payload.error || 'Doctor endpoint is not accessible.';
        setDoctorDiagnostics({
          status: 'unknown',
          findingsCount: 0,
          recommendationsCount: 0,
          findingDetails: [],
          recommendations: [],
          generatedAt: null,
          error,
        });
        setHealthDiagnostics({
          status: 'unknown',
          summary: null,
          issues: [],
          generatedAt: null,
          error,
        });
        return;
      }

      const summary = summarizeHealthChecks(payload.checks);
      setHealthDiagnostics({
        status:
          summary !== null ? toHealthDiagnosticsStatus(summary) : parseDiagnosticsStatus(payload.status),
        summary,
        issues: extractHealthIssues(payload.checks),
        generatedAt: payload.generatedAt || null,
        error: null,
      });

      setDoctorDiagnostics({
        status: parseDiagnosticsStatus(payload.status),
        findingsCount: Array.isArray(payload.findings) ? payload.findings.length : 0,
        recommendationsCount: Array.isArray(payload.recommendations)
          ? payload.recommendations.length
          : 0,
        findingDetails: extractDoctorFindingDetails(payload.findings),
        recommendations: Array.isArray(payload.recommendations)
          ? payload.recommendations.slice(0, 3)
          : [],
        generatedAt: payload.generatedAt || null,
        error: null,
      });
    } catch {
      const error = 'Doctor diagnostics request failed.';
      setDoctorDiagnostics({
        status: 'unknown',
        findingsCount: 0,
        recommendationsCount: 0,
        findingDetails: [],
        recommendations: [],
        generatedAt: null,
        error,
      });
      setHealthDiagnostics({
        status: 'unknown',
        summary: null,
        issues: [],
        generatedAt: null,
        error,
      });
    } finally {
      setDiagnosticsLoading(false);
    }
  }, [memoryDiagnosticsEnabled]);

  // Initial fetch
  useEffect(() => {
    void fetchDiagnostics();
  }, [fetchDiagnostics]);

  // Auto-refresh interval
  useEffect(() => {
    const interval = setInterval(() => {
      void fetchDiagnostics();
    }, DIAGNOSTICS_REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [fetchDiagnostics]);

  return {
    healthDiagnostics,
    doctorDiagnostics,
    diagnosticsLoading,
    memoryDiagnosticsEnabled,
    setMemoryDiagnosticsEnabled,
    fetchDiagnostics,
  };
}
