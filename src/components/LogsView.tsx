'use client';

import React, { useState } from 'react';
import { type LevelFilter } from '@/components/logs/diagnostics';
import { useLogs, useDiagnostics, useAutoScroll } from '@/components/logs/hooks';
import {
  LogsHeader,
  DiagnosticsPanel,
  LogsToolbar,
  LogTable,
  StatusBar,
} from '@/components/logs/components';

// Re-exports for backward compatibility
export {
  DIAGNOSTICS_REFRESH_INTERVAL_MS,
  extractDoctorFindingDetails,
  extractHealthIssues,
  toHealthIssueInsight,
} from '@/components/logs/diagnostics';

const LogsView: React.FC = () => {
  // Filter states
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [historyLimit, setHistoryLimit] = useState<number>(500);
  const [streamBufferLimit, setStreamBufferLimit] = useState<number>(1000);

  // Logs hook
  const {
    logs,
    filteredLogs,
    sources,
    categories,
    totalCount,
    hasMoreHistory,
    isLoadingMore,
    isConnected,
    isLoading,
    copiedId,
    loadOlder,
    handleClear,
    handleExport,
    handleCopyLog,
  } = useLogs({
    levelFilter,
    sourceFilter,
    categoryFilter,
    search,
    historyLimit,
    streamBufferLimit,
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
        historyLimit={historyLimit}
        onHistoryLimitChange={setHistoryLimit}
        streamBufferLimit={streamBufferLimit}
        onStreamBufferLimitChange={setStreamBufferLimit}
        hasMoreHistory={hasMoreHistory}
        isLoadingMore={isLoadingMore}
        onLoadOlder={() => void loadOlder()}
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
        hasMoreHistory={hasMoreHistory}
        autoScroll={autoScroll}
        isConnected={isConnected}
      />
    </div>
  );
};

export default LogsView;
