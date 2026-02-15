// ─── Worker Task Creation ───────────────────────────────────
// Form component to create new worker workspaces.

import React, { useState, useEffect } from 'react';
import type { WorkspaceType } from '../../types';

interface PersonaSummary {
  id: string;
  name: string;
  emoji: string;
  vibe: string;
}

interface WorkerTaskCreationProps {
  onSubmit: (
    objective: string,
    options?: {
      title?: string;
      priority?: string;
      workspaceType?: WorkspaceType;
      usePlanning?: boolean;
      personaId?: string | null;
    },
  ) => Promise<unknown>;
  onCancel: () => void;
}

const WORKSPACE_TYPES: {
  value: WorkspaceType;
  label: string;
  icon: string;
  description: string;
}[] = [
  {
    value: 'research',
    label: 'Research',
    icon: '📚',
    description: 'Web-Recherche, Analysen, PDF-Reports',
  },
  {
    value: 'webapp',
    label: 'Web App',
    icon: '🌐',
    description: 'Next.js, React, vollständige Web-Projekte',
  },
  {
    value: 'creative',
    label: 'Kreativ',
    icon: '🎨',
    description: 'Bilder, Grafiken, Design-Arbeiten',
  },
  {
    value: 'data',
    label: 'Daten',
    icon: '📊',
    description: 'CSV-Analyse, Charts, Datenverarbeitung',
  },
  {
    value: 'general',
    label: 'Allgemein',
    icon: '📝',
    description: 'Texte, Dokumente, sonstige Aufgaben',
  },
];

const PRIORITIES: { value: string; label: string; color: string }[] = [
  { value: 'low', label: 'Niedrig', color: '#6b7280' },
  { value: 'normal', label: 'Normal', color: '#3b82f6' },
  { value: 'high', label: 'Hoch', color: '#f59e0b' },
  { value: 'urgent', label: 'Dringend', color: '#ef4444' },
];

const WorkerTaskCreation: React.FC<WorkerTaskCreationProps> = ({ onSubmit, onCancel }) => {
  const [objective, setObjective] = useState('');
  const [title, setTitle] = useState('');
  const [workspaceType, setWorkspaceType] = useState<WorkspaceType>('general');
  const [priority, setPriority] = useState('normal');
  const [usePlanning, setUsePlanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [personas, setPersonas] = useState<PersonaSummary[]>([]);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(null);
  const [loadingPersonas, setLoadingPersonas] = useState(true);

  // Load available personas
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/personas');
        if (res.ok) {
          const data = await res.json();
          setPersonas(data.personas || []);
        }
      } catch {
        // ignore
      } finally {
        setLoadingPersonas(false);
      }
    })();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!objective.trim()) return;

    setSubmitting(true);
    try {
      await onSubmit(objective, {
        title: title.trim() || undefined,
        priority,
        workspaceType,
        usePlanning,
        personaId: selectedPersonaId,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="worker-creation">
      <div className="worker-creation__header">
        <button className="worker-btn worker-btn--ghost" onClick={onCancel}>
          ← Zurück
        </button>
        <h2>Neuer Workspace</h2>
      </div>

      <form className="worker-creation__form" onSubmit={handleSubmit}>
        {/* Workspace Type Selection */}
        <div className="worker-creation__field">
          <label>Workspace-Typ</label>
          <div className="worker-type-grid">
            {WORKSPACE_TYPES.map((wt) => (
              <button
                key={wt.value}
                type="button"
                className={`worker-type-card ${workspaceType === wt.value ? 'worker-type-card--active' : ''}`}
                onClick={() => setWorkspaceType(wt.value)}
              >
                <span className="worker-type-card__icon">{wt.icon}</span>
                <span className="worker-type-card__label">{wt.label}</span>
                <span className="worker-type-card__desc">{wt.description}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Title (optional) */}
        <div className="worker-creation__field">
          <label htmlFor="worker-title">Titel (optional)</label>
          <input
            id="worker-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Automatisch aus Aufgabe generiert…"
            className="worker-input"
          />
        </div>

        {/* Objective */}
        <div className="worker-creation__field">
          <label htmlFor="worker-objective">
            Aufgabe <span className="worker-required">*</span>
          </label>
          <textarea
            id="worker-objective"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="Beispiel: Recherchiere nach neuesten Therapien für..."
            className="worker-textarea"
            rows={5}
            required
          />
        </div>

        {/* Priority */}
        <div className="worker-creation__field">
          <label>Priorität</label>
          <div className="worker-priority-row">
            {PRIORITIES.map((p) => (
              <button
                key={p.value}
                type="button"
                className={`worker-priority-btn ${priority === p.value ? 'worker-priority-btn--active' : ''}`}
                style={
                  priority === p.value
                    ? { backgroundColor: `${p.color}22`, borderColor: p.color, color: p.color }
                    : {}
                }
                onClick={() => setPriority(p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Persona Selection */}
        <div className="worker-creation__field">
          <label>Persona (optional)</label>
          {loadingPersonas ? (
            <p className="worker-persona-loading">Personas laden…</p>
          ) : personas.length === 0 ? (
            <p className="worker-persona-empty">Keine Personas verfügbar.</p>
          ) : (
            <div className="worker-persona-grid">
              <button
                type="button"
                className={`worker-persona-card ${selectedPersonaId === null ? 'worker-persona-card--selected' : ''}`}
                onClick={() => setSelectedPersonaId(null)}
                title="Standard-Verhalten ohne spezifische Persona"
              >
                <span className="worker-persona-card__emoji">🤖</span>
                <div className="worker-persona-card__info">
                  <span className="worker-persona-card__name">Standard</span>
                  <span className="worker-persona-card__vibe">Allgemeiner Assistent</span>
                </div>
              </button>
              {personas.map((persona) => (
                <button
                  key={persona.id}
                  type="button"
                  className={`worker-persona-card ${selectedPersonaId === persona.id ? 'worker-persona-card--selected' : ''}`}
                  onClick={() => setSelectedPersonaId(persona.id)}
                  title={persona.vibe}
                >
                  <span className="worker-persona-card__emoji">{persona.emoji}</span>
                  <div className="worker-persona-card__info">
                    <span className="worker-persona-card__name">{persona.name}</span>
                    <span className="worker-persona-card__vibe">{persona.vibe}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Planning Mode Toggle */}
        <div className="worker-creation__field">
          <label className="worker-planning-toggle">
            <input
              type="checkbox"
              checked={usePlanning}
              onChange={(e) => setUsePlanning(e.target.checked)}
            />
            <span className="worker-planning-toggle__label">
              🧠 Planungsmodus — KI stellt Rückfragen vor der Ausführung
            </span>
          </label>
          {usePlanning && (
            <p className="worker-planning-toggle__hint">
              Die KI wird gezielte Fragen stellen, um die Aufgabe optimal zu verstehen, bevor sie
              mit der Ausführung beginnt.
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="worker-creation__actions">
          <button type="button" className="worker-btn worker-btn--ghost" onClick={onCancel}>
            Abbrechen
          </button>
          <button
            type="submit"
            className="worker-btn worker-btn--primary"
            disabled={!objective.trim() || submitting}
          >
            {submitting ? 'Wird erstellt…' : '🚀 Workspace starten'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default WorkerTaskCreation;
