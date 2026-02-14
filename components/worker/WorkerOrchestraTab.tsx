import React, { useState } from 'react';
import { useWorkerOrchestraFlows } from '../../src/modules/worker/hooks/useWorkerOrchestraFlows';

const DEFAULT_GRAPH = {
  startNodeId: 'n1',
  nodes: [{ id: 'n1', personaId: 'persona-default' }],
  edges: [],
};

const WorkerOrchestraTab: React.FC = () => {
  const { drafts, published, loading, error, createDraft, publishDraft } = useWorkerOrchestraFlows();
  const [name, setName] = useState('');
  const [workspaceType, setWorkspaceType] = useState('research');
  const [busy, setBusy] = useState(false);

  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      setBusy(true);
      await createDraft({
        name: name.trim(),
        workspaceType,
        graph: DEFAULT_GRAPH,
      });
      setName('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="worker-orchestra">
      <header className="worker-orchestra__header">
        <h2>🎼 Orchestra</h2>
        <p>Globale Flow-Definitionen für den Worker-Orchestrator.</p>
      </header>

      <form className="worker-orchestra__create" onSubmit={submitCreate}>
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
                  <button
                    className="worker-btn worker-btn--ghost"
                    onClick={() => publishDraft(draft.id)}
                    type="button"
                  >
                    Publish
                  </button>
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
    </section>
  );
};

export default WorkerOrchestraTab;
