'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, Search, Download, Check, AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import type { DiscoveredAgent } from '@/lib/types';

interface DiscoverAgentsModalProps {
  onClose: () => void;
  workspaceId?: string;
}

export function DiscoverAgentsModal({ onClose, workspaceId }: DiscoverAgentsModalProps) {
  const { addAgent } = useMissionControl();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<DiscoveredAgent[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    imported: number;
    skipped: number;
  } | null>(null);

  const discover = useCallback(async () => {
    setLoading(true);
    setError(null);
    setImportResult(null);

    try {
      const res = await fetch('/api/agents/discover');
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || `Failed to discover agents (${res.status})`);
        return;
      }
      const data = await res.json();
      setAgents(data.agents || []);
    } catch (err) {
      setError('Failed to connect to the server');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    discover();
  }, [discover]);

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAllAvailable = () => {
    const available = agents.filter((a) => !a.already_imported).map((a) => a.id);
    setSelectedIds(new Set(available));
  };

  const deselectAll = () => {
    setSelectedIds(new Set());
  };

  const handleImport = async () => {
    if (selectedIds.size === 0) return;

    setImporting(true);
    setError(null);

    try {
      const agentsToImport = agents
        .filter((a) => selectedIds.has(a.id))
        .map((a) => ({
          gateway_agent_id: a.id,
          name: a.name,
          model: a.model,
          workspace_id: workspaceId || 'default',
        }));

      const res = await fetch('/api/agents/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agents: agentsToImport }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to import agents');
        return;
      }

      const data = await res.json();

      // Add imported agents to the store
      for (const agent of data.imported) {
        addAgent(agent);
      }

      setImportResult({
        imported: data.imported.length,
        skipped: data.skipped.length,
      });

      // Refresh the discovery list
      await discover();
      setSelectedIds(new Set());
    } catch (err) {
      setError('Failed to import agents');
    } finally {
      setImporting(false);
    }
  };

  const availableCount = agents.filter((a) => !a.already_imported).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-mc-bg-secondary border-mc-border flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border">
        {/* Header */}
        <div className="border-mc-border flex items-center justify-between border-b p-4">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Search className="text-mc-accent h-5 w-5" />
              Discover Gateway Agents
            </h2>
            <p className="text-mc-text-secondary mt-1 text-sm">
              Import existing agents from the OpenClaw Gateway
            </p>
          </div>
          <button onClick={onClose} className="hover:bg-mc-bg-tertiary rounded p-1">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="text-mc-accent mr-3 h-6 w-6 animate-spin" />
              <span className="text-mc-text-secondary">Discovering agents from Gateway...</span>
            </div>
          )}

          {error && (
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-red-500/20 bg-red-500/10 p-4">
              <AlertCircle className="h-5 w-5 flex-shrink-0 text-red-400" />
              <span className="text-sm text-red-400">{error}</span>
            </div>
          )}

          {importResult && (
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-green-500/20 bg-green-500/10 p-4">
              <Check className="h-5 w-5 flex-shrink-0 text-green-400" />
              <span className="text-sm text-green-400">
                Imported {importResult.imported} agent{importResult.imported !== 1 ? 's' : ''}
                {importResult.skipped > 0 && ` (${importResult.skipped} skipped)`}
              </span>
            </div>
          )}

          {!loading && !error && agents.length === 0 && (
            <div className="text-mc-text-secondary py-12 text-center">
              <p>No agents found in the Gateway.</p>
              <p className="mt-2 text-sm">
                Make sure the OpenClaw Gateway is running and has agents configured.
              </p>
            </div>
          )}

          {!loading && agents.length > 0 && (
            <>
              {/* Selection controls */}
              <div className="mb-3 flex items-center justify-between">
                <span className="text-mc-text-secondary text-sm">
                  {agents.length} agent{agents.length !== 1 ? 's' : ''} found
                  {availableCount < agents.length &&
                    ` · ${agents.length - availableCount} already imported`}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={discover}
                    className="text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg-tertiary flex items-center gap-1 rounded px-2 py-1 text-xs"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Refresh
                  </button>
                  {availableCount > 0 && (
                    <>
                      <button
                        onClick={selectAllAvailable}
                        className="text-mc-accent hover:bg-mc-accent/10 rounded px-2 py-1 text-xs"
                      >
                        Select All
                      </button>
                      <button
                        onClick={deselectAll}
                        className="text-mc-text-secondary hover:bg-mc-bg-tertiary rounded px-2 py-1 text-xs"
                      >
                        Deselect All
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Agent list */}
              <div className="space-y-2">
                {agents.map((agent) => {
                  const isSelected = selectedIds.has(agent.id);
                  const isImported = agent.already_imported;

                  return (
                    <div
                      key={agent.id}
                      className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
                        isImported
                          ? 'border-mc-border/50 bg-mc-bg/50 opacity-60'
                          : isSelected
                            ? 'border-mc-accent/50 bg-mc-accent/5'
                            : 'border-mc-border hover:border-mc-border/80 hover:bg-mc-bg-tertiary cursor-pointer'
                      }`}
                      onClick={() => !isImported && toggleSelection(agent.id)}
                    >
                      {/* Checkbox */}
                      <div
                        className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border-2 ${
                          isImported
                            ? 'border-green-500/50 bg-green-500/20'
                            : isSelected
                              ? 'border-mc-accent bg-mc-accent'
                              : 'border-mc-border'
                        }`}
                      >
                        {(isSelected || isImported) && (
                          <Check
                            className={`h-3 w-3 ${isImported ? 'text-green-400' : 'text-mc-bg'}`}
                          />
                        )}
                      </div>

                      {/* Avatar */}
                      <span className="text-2xl">{isImported ? '🔗' : '🤖'}</span>

                      {/* Info */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{agent.name}</span>
                          {isImported && (
                            <span className="rounded bg-green-500/20 px-1.5 py-0.5 text-xs text-green-400">
                              Imported
                            </span>
                          )}
                        </div>
                        <div className="text-mc-text-secondary mt-0.5 flex items-center gap-3 text-xs">
                          {agent.model && <span>Model: {agent.model}</span>}
                          {agent.channel && <span>Channel: {agent.channel}</span>}
                          {agent.status && <span>Status: {agent.status}</span>}
                          <span className="text-mc-text-secondary/60">ID: {agent.id}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-mc-border flex items-center justify-between border-t p-4">
          <span className="text-mc-text-secondary text-sm">
            {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select agents to import'}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="text-mc-text-secondary hover:text-mc-text px-4 py-2 text-sm"
            >
              {importResult ? 'Done' : 'Cancel'}
            </button>
            <button
              onClick={handleImport}
              disabled={selectedIds.size === 0 || importing}
              className="bg-mc-accent text-mc-bg hover:bg-mc-accent/90 flex items-center gap-2 rounded px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
            >
              {importing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Importing...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4" />
                  Import {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
