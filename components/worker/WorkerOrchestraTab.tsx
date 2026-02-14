import React, { useEffect, useRef, useState } from 'react';
import { useWorkerOrchestraFlows } from '../../src/modules/worker/hooks/useWorkerOrchestraFlows';

const DEFAULT_GRAPH = {
  startNodeId: 'n1',
  nodes: [{ id: 'n1', personaId: 'persona-default' }],
  edges: [],
};

type GraphNode = {
  id: string;
  personaId: string;
};

type GraphEdge = {
  from: string;
  to: string;
};

type DraftGraph = {
  startNodeId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

function parseDraftGraph(graphJson?: string): DraftGraph {
  if (!graphJson) return { ...DEFAULT_GRAPH };
  try {
    const parsed = JSON.parse(graphJson) as Partial<DraftGraph>;
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      return { ...DEFAULT_GRAPH };
    }
    const nodes = parsed.nodes
      .filter((node): node is GraphNode => !!node && typeof node.id === 'string')
      .map((node) => ({
        id: node.id.trim(),
        personaId: typeof node.personaId === 'string' ? node.personaId : 'persona-default',
      }))
      .filter((node) => node.id.length > 0);
    const edges = parsed.edges
      .filter((edge): edge is GraphEdge => !!edge && typeof edge.from === 'string' && typeof edge.to === 'string')
      .map((edge) => ({ from: edge.from.trim(), to: edge.to.trim() }))
      .filter((edge) => edge.from.length > 0 && edge.to.length > 0);

    if (nodes.length === 0) return { ...DEFAULT_GRAPH };
    return {
      startNodeId:
        typeof parsed.startNodeId === 'string' && parsed.startNodeId.trim().length > 0
          ? parsed.startNodeId.trim()
          : nodes[0]!.id,
      nodes,
      edges,
    };
  } catch {
    return { ...DEFAULT_GRAPH };
  }
}

function graphForDraft(drafts: Array<{ id: string; graphJson?: string }>, draftId: string | null): DraftGraph {
  const draft = drafts.find((item) => item.id === draftId);
  return parseDraftGraph(draft?.graphJson);
}

const WorkerOrchestraTab: React.FC = () => {
  const { drafts, published, loading, error, createDraft, publishDraft, updateDraft } =
    useWorkerOrchestraFlows();
  const [name, setName] = useState('');
  const [workspaceType, setWorkspaceType] = useState('research');
  const [busy, setBusy] = useState(false);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [draftGraph, setDraftGraph] = useState<DraftGraph>({ ...DEFAULT_GRAPH });
  const [newNodeId, setNewNodeId] = useState('');
  const [newNodePersona, setNewNodePersona] = useState('persona-default');
  const [edgeFrom, setEdgeFrom] = useState('');
  const [edgeTo, setEdgeTo] = useState('');
  const [graphMessage, setGraphMessage] = useState<string | null>(null);
  const builderRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (drafts.length === 0) {
      setSelectedDraftId(null);
      setDraftGraph({ ...DEFAULT_GRAPH });
      return;
    }
    const nextSelected =
      selectedDraftId && drafts.some((draft) => draft.id === selectedDraftId)
        ? selectedDraftId
        : drafts[0]!.id;
    if (nextSelected !== selectedDraftId) {
      setSelectedDraftId(nextSelected);
      setDraftGraph(graphForDraft(drafts, nextSelected));
      setEdgeFrom('');
      setEdgeTo('');
      setGraphMessage(null);
    }
  }, [drafts, selectedDraftId]);

  const submitDraft = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const ok = editingDraftId
        ? await updateDraft(editingDraftId, {
            name: name.trim(),
            workspaceType,
          })
        : await createDraft({
            name: name.trim(),
            workspaceType,
            graph: DEFAULT_GRAPH,
          });
      if (ok) {
        setName('');
        setWorkspaceType('research');
        setEditingDraftId(null);
      }
    } catch {
      // createDraft handles error state in hook
    } finally {
      setBusy(false);
    }
  };

  const handlePublish = async (flowId: string) => {
    try {
      setBusy(true);
      await publishDraft(flowId);
    } catch {
      // publishDraft handles error state in hook
    } finally {
      setBusy(false);
    }
  };

  const startEditing = (draftId: string, draftName: string, draftWorkspaceType: string) => {
    setEditingDraftId(draftId);
    setSelectedDraftId(draftId);
    setDraftGraph(graphForDraft(drafts, draftId));
    setName(draftName);
    setWorkspaceType(draftWorkspaceType);
    setGraphMessage(null);
  };

  const stopEditing = () => {
    setEditingDraftId(null);
    setName('');
    setWorkspaceType('research');
    setGraphMessage(null);
  };

  const selectDraft = (draftId: string) => {
    setSelectedDraftId(draftId);
    setDraftGraph(graphForDraft(drafts, draftId));
    const selected = drafts.find((draft) => draft.id === draftId);
    setGraphMessage(selected ? `Canvas geöffnet: ${selected.name}` : null);
    requestAnimationFrame(() => {
      builderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const addNode = () => {
    const id = newNodeId.trim();
    if (!id) return;
    if (draftGraph.nodes.some((node) => node.id === id)) {
      setGraphMessage(`Knoten "${id}" existiert bereits.`);
      return;
    }
    const nextNodes = [
      ...draftGraph.nodes,
      {
        id,
        personaId: newNodePersona.trim() || 'persona-default',
      },
    ];
    const nextGraph = {
      ...draftGraph,
      nodes: nextNodes,
      startNodeId: draftGraph.startNodeId || nextNodes[0]!.id,
    };
    setDraftGraph(nextGraph);
    setNewNodeId('');
    setGraphMessage(null);
  };

  const removeNode = (nodeId: string) => {
    const nodes = draftGraph.nodes.filter((node) => node.id !== nodeId);
    if (nodes.length === 0) {
      setGraphMessage('Ein Flow braucht mindestens einen Knoten.');
      return;
    }
    const edges = draftGraph.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
    setDraftGraph({
      startNodeId: draftGraph.startNodeId === nodeId ? nodes[0]!.id : draftGraph.startNodeId,
      nodes,
      edges,
    });
    setGraphMessage(null);
  };

  const addEdge = () => {
    if (!edgeFrom || !edgeTo) return;
    if (edgeFrom === edgeTo) {
      setGraphMessage('Kante von einem Knoten auf sich selbst ist nicht erlaubt.');
      return;
    }
    if (draftGraph.edges.some((edge) => edge.from === edgeFrom && edge.to === edgeTo)) {
      setGraphMessage('Diese Kante existiert bereits.');
      return;
    }
    setDraftGraph({
      ...draftGraph,
      edges: [...draftGraph.edges, { from: edgeFrom, to: edgeTo }],
    });
    setEdgeFrom('');
    setEdgeTo('');
    setGraphMessage(null);
  };

  const removeEdge = (edge: GraphEdge) => {
    setDraftGraph({
      ...draftGraph,
      edges: draftGraph.edges.filter((item) => !(item.from === edge.from && item.to === edge.to)),
    });
    setGraphMessage(null);
  };

  const saveGraph = async () => {
    const draftId = selectedDraftId ?? drafts[0]?.id ?? null;
    if (!draftId) return;
    setBusy(true);
    const ok = await updateDraft(draftId, { graph: draftGraph });
    if (ok) {
      setGraphMessage('Flow-Canvas gespeichert.');
    }
    setBusy(false);
  };

  const resolvedSelectedDraftId = selectedDraftId ?? drafts[0]?.id ?? null;
  const resolvedSelectedDraft = drafts.find((draft) => draft.id === resolvedSelectedDraftId) || null;
  const renderedGraph =
    selectedDraftId === null ? graphForDraft(drafts, resolvedSelectedDraftId) : draftGraph;

  const NODE_WIDTH = 180;
  const NODE_HEIGHT = 88;
  const GAP_X = 48;
  const canvasWidth = Math.max(320, renderedGraph.nodes.length * (NODE_WIDTH + GAP_X) + 32);
  const canvasHeight = 210;
  const nodePosition = (index: number) => ({
    x: 16 + index * (NODE_WIDTH + GAP_X),
    y: 44,
  });

  const nodeIndexById = new Map(renderedGraph.nodes.map((node, index) => [node.id, index]));

  return (
    <section className="worker-orchestra">
      <header className="worker-orchestra__header">
        <h2>🎼 Orchestra</h2>
        <p>Globale Flow-Definitionen für den Worker-Orchestrator.</p>
      </header>

      <div className="worker-orchestra__explain">
        <h3>Was ist Orchestra?</h3>
        <p>
          Orchestra legt fest, wie Aufgaben durch Personas laufen. Ein <strong>Draft</strong> ist ein
          Entwurf. Erst <strong>Published</strong> wird live genutzt.
        </p>
      </div>

      <form className="worker-orchestra__create" onSubmit={submitDraft}>
        <input
          className="worker-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Flow Name"
        />
        <select
          className="worker-input"
          value={workspaceType}
          onChange={(event) => setWorkspaceType(event.target.value)}
        >
          <option value="research">Research</option>
          <option value="webapp">WebApp</option>
          <option value="data">Daten</option>
          <option value="general">Allgemein</option>
        </select>
        <button className="worker-btn worker-btn--primary" type="submit" disabled={busy}>
          {busy ? 'Speichere…' : editingDraftId ? 'Draft aktualisieren' : 'Draft erstellen'}
        </button>
        {editingDraftId && (
          <button className="worker-btn worker-btn--ghost" type="button" onClick={stopEditing}>
            Bearbeitung abbrechen
          </button>
        )}
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
                <li
                  key={draft.id}
                  className={`worker-orchestra__item ${resolvedSelectedDraftId === draft.id ? 'worker-orchestra__item--active' : ''}`}
                >
                  <div>
                    <strong>{draft.name}</strong>
                    <span>{draft.workspaceType}</span>
                  </div>
                  <div className="worker-orchestra__item-actions">
                    {resolvedSelectedDraftId === draft.id ? (
                      <span className="worker-orchestra__pill worker-orchestra__pill--active">
                        Canvas aktiv
                      </span>
                    ) : null}
                    <button
                      className="worker-btn worker-btn--ghost"
                      onClick={() => selectDraft(draft.id)}
                      type="button"
                    >
                      {resolvedSelectedDraftId === draft.id ? 'Canvas öffnen' : 'Canvas'}
                    </button>
                    <button
                      className="worker-btn worker-btn--ghost"
                      onClick={() => handlePublish(draft.id)}
                      type="button"
                      disabled={busy}
                    >
                      Publish
                    </button>
                    <button
                      className="worker-btn worker-btn--ghost"
                      onClick={() => startEditing(draft.id, draft.name, draft.workspaceType)}
                      type="button"
                      disabled={busy}
                    >
                      Bearbeiten
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3>Published</h3>
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

      <section className="worker-orchestra__builder" ref={builderRef}>
        <div className="worker-orchestra__builder-header">
          <h3>Flow-Canvas</h3>
          <p>
            {resolvedSelectedDraftId
              ? 'Visualisierung und Bearbeitung des ausgewählten Drafts.'
              : 'Wähle zuerst einen Draft aus.'}
          </p>
          <p className="worker-orchestra__active-draft">
            Aktiver Draft im Canvas: <strong>{resolvedSelectedDraft?.name || '—'}</strong>
          </p>
        </div>

        <div className="worker-orchestra__canvas-wrap">
          <div className="worker-orchestra__canvas" role="img" aria-label="Flow-Canvas">
            <svg width={canvasWidth} height={canvasHeight}>
              {renderedGraph.edges.map((edge) => {
                const fromIndex = nodeIndexById.get(edge.from);
                const toIndex = nodeIndexById.get(edge.to);
                if (fromIndex === undefined || toIndex === undefined) return null;
                const from = nodePosition(fromIndex);
                const to = nodePosition(toIndex);
                return (
                  <line
                    key={`${edge.from}->${edge.to}`}
                    x1={from.x + NODE_WIDTH}
                    y1={from.y + NODE_HEIGHT / 2}
                    x2={to.x}
                    y2={to.y + NODE_HEIGHT / 2}
                    stroke="currentColor"
                    strokeWidth="2"
                    opacity="0.65"
                  />
                );
              })}
            </svg>
            {renderedGraph.nodes.map((node, index) => {
              const pos = nodePosition(index);
              return (
                <article
                  key={node.id}
                  className={`worker-orchestra__canvas-node ${renderedGraph.startNodeId === node.id ? 'worker-orchestra__canvas-node--start' : ''}`}
                  style={{ left: pos.x, top: pos.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                >
                  <strong>{node.id}</strong>
                  <span>{node.personaId}</span>
                  {renderedGraph.startNodeId === node.id && <small>Start</small>}
                </article>
              );
            })}
          </div>
        </div>

        <div className="worker-orchestra__builder-controls">
          <div className="worker-orchestra__row">
            <input
              className="worker-input"
              placeholder="Neuer Knoten (z. B. research)"
              value={newNodeId}
              onChange={(event) => setNewNodeId(event.target.value)}
            />
            <input
              className="worker-input"
              placeholder="Persona ID"
              value={newNodePersona}
              onChange={(event) => setNewNodePersona(event.target.value)}
            />
            <button className="worker-btn worker-btn--ghost" type="button" onClick={addNode}>
              Knoten hinzufügen
            </button>
          </div>
          <div className="worker-orchestra__row">
            <select
              className="worker-input"
              value={edgeFrom}
              onChange={(event) => setEdgeFrom(event.target.value)}
            >
              <option value="">Von…</option>
              {renderedGraph.nodes.map((node) => (
                <option key={`from-${node.id}`} value={node.id}>
                  {node.id}
                </option>
              ))}
            </select>
            <select className="worker-input" value={edgeTo} onChange={(event) => setEdgeTo(event.target.value)}>
              <option value="">Nach…</option>
              {renderedGraph.nodes.map((node) => (
                <option key={`to-${node.id}`} value={node.id}>
                  {node.id}
                </option>
              ))}
            </select>
            <button className="worker-btn worker-btn--ghost" type="button" onClick={addEdge}>
              Kante hinzufügen
            </button>
          </div>
          <div className="worker-orchestra__row worker-orchestra__row--wrap">
            {renderedGraph.nodes.map((node) => (
              <button
                key={`remove-node-${node.id}`}
                type="button"
                className="worker-btn worker-btn--ghost"
                onClick={() => removeNode(node.id)}
              >
                Node löschen: {node.id}
              </button>
            ))}
            {renderedGraph.edges.map((edge) => (
              <button
                key={`remove-edge-${edge.from}-${edge.to}`}
                type="button"
                className="worker-btn worker-btn--ghost"
                onClick={() => removeEdge(edge)}
              >
                Kante löschen: {edge.from} → {edge.to}
              </button>
            ))}
          </div>
          <div className="worker-orchestra__row">
            <button
              className="worker-btn worker-btn--primary"
              type="button"
              disabled={!resolvedSelectedDraftId || busy}
              onClick={saveGraph}
            >
              Canvas speichern
            </button>
            {graphMessage && <span className="worker-orchestra__message">{graphMessage}</span>}
          </div>
        </div>
      </section>
    </section>
  );
};

export default WorkerOrchestraTab;
