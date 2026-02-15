'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Node, Edge } from '@xyflow/react';
import { useWorkerOrchestraFlows } from '../../src/modules/worker/hooks/useWorkerOrchestraFlows';
import { usePersona } from '../../src/modules/personas/PersonaContext';
import {
  orchestraGraphToReactFlow,
  reactFlowToOrchestraGraph,
  autoLayoutGraph,
  type PersonaNodeData,
  type PersonaInfo,
} from '../../src/shared/lib/orchestra-graph-converter';
import type { OrchestraFlowGraph } from '../../src/server/worker/orchestraGraph';
import { OrchestraCanvas, type OrchestraCanvasApi } from './orchestra/OrchestraCanvas';
import { OrchestraToolbar } from './orchestra/OrchestraToolbar';
import { NodeLibrary } from './orchestra/NodeLibrary';
import { NodePropertiesPanel, type SkillOption } from './orchestra/NodePropertiesPanel';

// ─── View mode ───────────────────────────────────────────────

type ViewMode = 'list' | 'canvas';

// ─── Helpers ─────────────────────────────────────────────────

function parseGraphJson(graphJson?: string): OrchestraFlowGraph | null {
  if (!graphJson) return null;
  try {
    const parsed = JSON.parse(graphJson) as Partial<OrchestraFlowGraph>;
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed as OrchestraFlowGraph;
  } catch {
    return null;
  }
}

// ─── Component ───────────────────────────────────────────────

const WorkerOrchestraTab: React.FC = () => {
  const { drafts, published, loading, error, createDraft, publishDraft, updateDraft, deleteDraft } =
    useWorkerOrchestraFlows();
  const { personas: personaSummaries } = usePersona();

  // ─── State ──────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [canvasNodes, setCanvasNodes] = useState<Node<PersonaNodeData>[]>([]);
  const [canvasEdges, setCanvasEdges] = useState<Edge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [newFlowName, setNewFlowName] = useState('');
  const [newFlowType, setNewFlowType] = useState('research');
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [canvasApi, setCanvasApi] = useState<OrchestraCanvasApi | null>(null);

  // ─── Derived ────────────────────────────────────────────
  const personaInfos: PersonaInfo[] = useMemo(
    () => personaSummaries.map((p) => ({ id: p.id, name: p.name, emoji: p.emoji })),
    [personaSummaries],
  );

  const activeDraft = useMemo(
    () => drafts.find((d) => d.id === activeDraftId) ?? null,
    [drafts, activeDraftId],
  );

  const selectedNode = useMemo(
    () => canvasNodes.find((n) => n.id === selectedNodeId) ?? null,
    [canvasNodes, selectedNodeId],
  );

  const allNodeIds = useMemo(() => canvasNodes.map((n) => n.id), [canvasNodes]);

  // ─── Load skills on mount ──────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/skills');
        if (res.ok) {
          const data = (await res.json()) as {
            skills?: Array<{ id: string; name: string; installed: boolean }>;
          };
          setSkills(
            (data.skills ?? []).filter((s) => s.installed).map((s) => ({ id: s.id, name: s.name })),
          );
        }
      } catch {
        // non-critical
      }
    })();
  }, []);

  // ─── Open draft in canvas ──────────────────────────────
  const openDraftCanvas = useCallback(
    (draftId: string) => {
      const draft = drafts.find((d) => d.id === draftId);
      if (!draft) return;
      const graph = parseGraphJson(draft.graphJson);
      if (graph) {
        const { nodes, edges } = orchestraGraphToReactFlow(graph, personaInfos);
        setCanvasNodes(nodes);
        setCanvasEdges(edges);
      } else {
        setCanvasNodes([]);
        setCanvasEdges([]);
      }
      setActiveDraftId(draftId);
      setSelectedNodeId(null);
      setIsDirty(false);
      setViewMode('canvas');
    },
    [drafts, personaInfos],
  );

  // ─── Create new draft ──────────────────────────────────
  const handleCreateDraft = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!newFlowName.trim()) return;
      setBusy(true);
      const emptyGraph: OrchestraFlowGraph = { startNodeId: undefined, nodes: [], edges: [] };
      const ok = await createDraft({
        name: newFlowName.trim(),
        workspaceType: newFlowType,
        graph: emptyGraph as unknown as Record<string, unknown>,
      });
      if (ok) {
        setNewFlowName('');
        setNewFlowType('research');
      }
      setBusy(false);
    },
    [newFlowName, newFlowType, createDraft],
  );

  // ─── Canvas graph change handler ───────────────────────
  const handleGraphChange = useCallback((nodes: Node<PersonaNodeData>[], edges: Edge[]) => {
    setCanvasNodes(nodes);
    setCanvasEdges(edges);
    setIsDirty(true);
  }, []);

  // ─── Node property updates ─────────────────────────────
  const handleNodeUpdate = useCallback((nodeId: string, updates: Partial<PersonaNodeData>) => {
    setCanvasNodes(
      (prev) =>
        prev.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, ...updates } } : n,
        ) as Node<PersonaNodeData>[],
    );
    setIsDirty(true);
  }, []);

  const handleSetStartNode = useCallback((nodeId: string) => {
    setCanvasNodes(
      (prev) =>
        prev.map((n) => ({
          ...n,
          data: { ...n.data, isStartNode: n.id === nodeId },
        })) as Node<PersonaNodeData>[],
    );
    setIsDirty(true);
  }, []);

  const handleDeleteNode = useCallback((nodeId: string) => {
    setCanvasNodes((prev) => {
      const remaining = prev.filter((n) => n.id !== nodeId);
      // Reassign start if needed
      if (remaining.length > 0 && !remaining.some((n) => n.data.isStartNode)) {
        remaining[0] = {
          ...remaining[0]!,
          data: { ...remaining[0]!.data, isStartNode: true },
        };
      }
      return remaining as Node<PersonaNodeData>[];
    });
    setCanvasEdges((prev) => prev.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setSelectedNodeId(null);
    setIsDirty(true);
  }, []);

  // ─── Toolbar actions ───────────────────────────────────

  const handleAutoLayout = useCallback(() => {
    const laid = autoLayoutGraph(canvasNodes, canvasEdges);
    setCanvasNodes(laid);
    setIsDirty(true);
  }, [canvasNodes, canvasEdges]);

  const handleSave = useCallback(async () => {
    if (!activeDraftId) return;
    setBusy(true);
    const graph = reactFlowToOrchestraGraph(canvasNodes, canvasEdges);
    const ok = await updateDraft(activeDraftId, {
      graph: graph as unknown as Record<string, unknown>,
    });
    if (ok) {
      setIsDirty(false);
    }
    setBusy(false);
  }, [activeDraftId, canvasNodes, canvasEdges, updateDraft]);

  const handlePublish = useCallback(async () => {
    if (!activeDraftId) return;
    // Save first if dirty
    if (isDirty) {
      setBusy(true);
      const graph = reactFlowToOrchestraGraph(canvasNodes, canvasEdges);
      const ok = await updateDraft(activeDraftId, {
        graph: graph as unknown as Record<string, unknown>,
      });
      if (!ok) {
        setBusy(false);
        return;
      }
      setIsDirty(false);
      setBusy(false);
    }
    setPublishing(true);
    await publishDraft(activeDraftId);
    setPublishing(false);
  }, [activeDraftId, isDirty, canvasNodes, canvasEdges, updateDraft, publishDraft]);

  const handleDeleteFlow = useCallback(async () => {
    if (!activeDraftId) return;
    if (!window.confirm('Diesen Flow-Draft wirklich löschen?')) return;
    setBusy(true);
    const ok = await deleteDraft(activeDraftId);
    if (ok) {
      setActiveDraftId(null);
      setViewMode('list');
      setCanvasNodes([]);
      setCanvasEdges([]);
      setIsDirty(false);
    }
    setBusy(false);
  }, [activeDraftId, deleteDraft]);

  const handleUndo = useCallback(() => {
    canvasApi?.undo();
  }, [canvasApi]);

  const handleRedo = useCallback(() => {
    canvasApi?.redo();
  }, [canvasApi]);

  // ─── Render: List View ─────────────────────────────────

  if (viewMode === 'list') {
    return (
      <section className="worker-orchestra">
        <header className="worker-orchestra__header">
          <h2>🎼 Orchestra</h2>
          <p>Visueller Workflow-Builder für Persona-Orchestrierung.</p>
        </header>

        {/* Create form */}
        <form className="worker-orchestra__create" onSubmit={handleCreateDraft}>
          <input
            className="worker-input"
            value={newFlowName}
            onChange={(e) => setNewFlowName(e.target.value)}
            placeholder="Neuer Flow Name"
          />
          <select
            className="worker-input"
            value={newFlowType}
            onChange={(e) => setNewFlowType(e.target.value)}
          >
            <option value="research">Research</option>
            <option value="webapp">WebApp</option>
            <option value="data">Daten</option>
            <option value="general">Allgemein</option>
          </select>
          <button className="worker-btn worker-btn--primary" type="submit" disabled={busy}>
            {busy ? 'Erstelle…' : 'Draft erstellen'}
          </button>
        </form>

        {loading && <p>Orchestra-Flows werden geladen…</p>}
        {error && <p className="worker-alert worker-alert--error">{error}</p>}

        <div className="worker-orchestra__grid">
          <div>
            <h3>Drafts</h3>
            {drafts.length === 0 ? (
              <p>Keine Drafts vorhanden.</p>
            ) : (
              <ul className="worker-orchestra__list">
                {drafts.map((draft) => (
                  <li key={draft.id} className="worker-orchestra__item">
                    <div>
                      <strong>{draft.name}</strong>
                      <span>{draft.workspaceType}</span>
                    </div>
                    <div className="worker-orchestra__item-actions">
                      <button
                        className="worker-btn worker-btn--primary"
                        onClick={() => openDraftCanvas(draft.id)}
                        type="button"
                      >
                        Canvas öffnen
                      </button>
                      <button
                        className="worker-btn worker-btn--ghost"
                        onClick={async () => {
                          setBusy(true);
                          await publishDraft(draft.id);
                          setBusy(false);
                        }}
                        type="button"
                        disabled={busy}
                      >
                        Veröffentlichen
                      </button>
                      <button
                        className="worker-btn worker-btn--ghost"
                        onClick={async () => {
                          if (!window.confirm(`Draft "${draft.name}" wirklich löschen?`)) return;
                          setBusy(true);
                          await deleteDraft(draft.id);
                          setBusy(false);
                        }}
                        type="button"
                        disabled={busy}
                      >
                        🗑️
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3>Veröffentlicht</h3>
            {published.length === 0 ? (
              <p>Keine veröffentlichten Flows.</p>
            ) : (
              <ul className="worker-orchestra__list">
                {published.map((flow) => (
                  <li key={flow.id} className="worker-orchestra__item">
                    <div>
                      <strong>{flow.name}</strong>
                      <span>
                        v{flow.version} · {flow.workspaceType}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    );
  }

  // ─── Render: Canvas View ───────────────────────────────

  return (
    <section className="worker-orchestra worker-orchestra--canvas-mode">
      <OrchestraToolbar
        flowName={activeDraft?.name ?? 'Unbenannt'}
        isDirty={isDirty}
        canUndo={canvasApi?.canUndo() ?? false}
        canRedo={canvasApi?.canRedo() ?? false}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onAutoLayout={handleAutoLayout}
        onSave={handleSave}
        onPublish={handlePublish}
        onDelete={handleDeleteFlow}
        saving={busy}
        publishing={publishing}
      />
      <button
        className="worker-btn worker-btn--ghost orchestra-back-btn"
        onClick={() => {
          if (isDirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return;
          setViewMode('list');
          setActiveDraftId(null);
          setIsDirty(false);
        }}
        type="button"
      >
        ← Zurück zur Übersicht
      </button>

      {error && <p className="worker-alert worker-alert--error">{error}</p>}

      <div className="worker-orchestra__workspace">
        <NodeLibrary personas={personaInfos} />

        <div className="worker-orchestra__canvas-container">
          <ReactFlowProvider>
            <OrchestraCanvas
              initialNodes={canvasNodes}
              initialEdges={canvasEdges}
              personas={personaInfos}
              onGraphChange={handleGraphChange}
              onNodeSelect={setSelectedNodeId}
              onApiChange={setCanvasApi}
            />
          </ReactFlowProvider>
        </div>

        <NodePropertiesPanel
          node={selectedNode}
          personas={personaInfos}
          skills={skills}
          allNodeIds={allNodeIds}
          onUpdate={handleNodeUpdate}
          onSetStartNode={handleSetStartNode}
          onDeleteNode={handleDeleteNode}
        />
      </div>
    </section>
  );
};

export default WorkerOrchestraTab;
