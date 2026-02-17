'use client';

import React, { useState } from 'react';
import {
  DIAGNOSTICS_REFRESH_INTERVAL_MS,
  extractDoctorFindingDetails,
  extractHealthIssues,
  toHealthIssueInsight,
  type LevelFilter,
} from './logs/diagnostics';
import { useLogs, useDiagnostics, useAutoScroll } from './logs/hooks';
import {
  LogsHeader,
  DiagnosticsPanel,
  LogsToolbar,
  LogTable,
  StatusBar,
} from './logs/components';

// Re-exports for backward compatibility
export {
  DIAGNOSTICS_REFRESH_INTERVAL_MS,
  extractDoctorFindingDetails,
  extractHealthIssues,
  toHealthIssueInsight,
} from './logs/diagnostics';

const LogsView: React.FC = () => {
  // Filter states
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  // Logs hook
  const {
    logs,
    filteredLogs,
    sources,
    categories,
    totalCount,
    isConnected,
    isLoading,
    copiedId,
    handleClear,
    handleExport,
    handleCopyLog,
  } = useLogs({
    levelFilter,
    sourceFilter,
    categoryFilter,
    search,
  });

  // Diagnostics hook
  const {
    healthDiagnostics,
    doctorDiagnostics,
    diagnosticsLoading,
    memoryDiagnosticsEnabled,
    setMemoryDiagnosticsEnabled,
    fetchDiagnostics,
  } = useDiagnostics();

  // Auto-scroll hook
  const { scrollRef, autoScroll, handleScroll, toggleAutoScroll } = useAutoScroll<HTMLDivElement>({
    deps: [logs],
  });

  return (
    <div className="animate-in fade-in flex h-full flex-col space-y-4 duration-500">
      <LogsHeader isConnected={isConnected} totalCount={totalCount} />

      <DiagnosticsPanel
        healthDiagnostics={healthDiagnostics}
        doctorDiagnostics={doctorDiagnostics}
        diagnosticsLoading={diagnosticsLoading}
        memoryDiagnosticsEnabled={memoryDiagnosticsEnabled}
        onToggleMemoryDiagnostics={() => setMemoryDiagnosticsEnabled((prev) => !prev)}
        onRefresh={() => void fetchDiagnostics()}
      />

      <LogsToolbar
        search={search}
        onSearchChange={setSearch}
        levelFilter={levelFilter}
        onLevelFilterChange={setLevelFilter}
        sourceFilter={sourceFilter}
        onSourceFilterChange={setSourceFilter}
        categoryFilter={categoryFilter}
        onCategoryFilterChange={setCategoryFilter}
        sources={sources}
        categories={categories}
        autoScroll={autoScroll}
        onToggleAutoScroll={toggleAutoScroll}
        logsCount={logs.length}
        onExport={handleExport}
        onClear={() => void handleClear()}
      />

      <LogTable
        logs={logs}
        filteredLogs={filteredLogs}
        isLoading={isLoading}
        copiedId={copiedId}
        scrollRef={scrollRef}
        onScroll={handleScroll}
        onCopyLog={handleCopyLog}
        search={search}
        levelFilter={levelFilter}
        sourceFilter={sourceFilter}
        categoryFilter={categoryFilter}
      />

      <StatusBar
        filteredCount={filteredLogs.length}
        totalCount={totalCount}
        autoScroll={autoScroll}
        isConnected={isConnected}
      />
    </div>
  );
};

export default LogsView;
