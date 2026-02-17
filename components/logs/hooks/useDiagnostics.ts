'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  DIAGNOSTICS_REFRESH_INTERVAL_MS,
  MEMORY_DIAGNOSTICS_STORAGE_KEY,
  extractDoctorFindingDetails,
  extractHealthIssues,
  parseDiagnosticsStatus,
  type DoctorApiResponse,
  type DoctorDiagnosticsState,
  type HealthApiResponse,
  type HealthDiagnosticsState,
} from '../diagnostics';

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

    const [healthResult, doctorResult] = await Promise.allSettled([
      fetch(`/api/health?memoryDiagnostics=${memoryDiagnosticsFlag}`),
      fetch(`/api/doctor?memoryDiagnostics=${memoryDiagnosticsFlag}`),
    ]);

    if (healthResult.status === 'fulfilled') {
      try {
        const payload = (await healthResult.value.json()) as HealthApiResponse;
        if (!healthResult.value.ok || payload.ok === false) {
          setHealthDiagnostics({
            status: 'unknown',
            summary: null,
            issues: [],
            generatedAt: null,
            error: payload.error || 'Health endpoint is not accessible.',
          });
        } else {
          setHealthDiagnostics({
            status: parseDiagnosticsStatus(payload.status),
            summary: payload.summary || null,
            issues: extractHealthIssues(payload.checks),
            generatedAt: payload.generatedAt || null,
            error: null,
          });
        }
      } catch {
        setHealthDiagnostics({
          status: 'unknown',
          summary: null,
          issues: [],
          generatedAt: null,
          error: 'Health response parsing failed.',
        });
      }
    } else {
      setHealthDiagnostics({
        status: 'unknown',
        summary: null,
        issues: [],
        generatedAt: null,
        error: 'Health diagnostics request failed.',
      });
    }

    if (doctorResult.status === 'fulfilled') {
      try {
        const payload = (await doctorResult.value.json()) as DoctorApiResponse;
        if (!doctorResult.value.ok || payload.ok === false) {
          setDoctorDiagnostics({
            status: 'unknown',
            findingsCount: 0,
            recommendationsCount: 0,
            findingDetails: [],
            recommendations: [],
            generatedAt: null,
            error: payload.error || 'Doctor endpoint is not accessible.',
          });
        } else {
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
        }
      } catch {
        setDoctorDiagnostics({
          status: 'unknown',
          findingsCount: 0,
          recommendationsCount: 0,
          findingDetails: [],
          recommendations: [],
          generatedAt: null,
          error: 'Doctor response parsing failed.',
        });
      }
    } else {
      setDoctorDiagnostics({
        status: 'unknown',
        findingsCount: 0,
        recommendationsCount: 0,
        findingDetails: [],
        recommendations: [],
        generatedAt: null,
        error: 'Doctor diagnostics request failed.',
      });
    }

    setDiagnosticsLoading(false);
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
