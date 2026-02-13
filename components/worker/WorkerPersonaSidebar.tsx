// ─── Worker Persona Sidebar ──────────────────────────────────
// Shows available personas and allows assignment to tasks.

import React, { useState, useEffect, useCallback } from 'react';

interface PersonaSummary {
  id: string;
  name: string;
  emoji: string;
  vibe: string;
}

interface WorkerPersonaSidebarProps {
  selectedTaskId: string | null;
  assignedPersonaId: string | null;
  onAssign: (taskId: string, personaId: string | null) => Promise<void>;
}

const WorkerPersonaSidebar: React.FC<WorkerPersonaSidebarProps> = ({
  selectedTaskId,
  assignedPersonaId,
  onAssign,
}) => {
  const [personas, setPersonas] = useState<PersonaSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/personas');
        if (res.ok) {
          const data = await res.json();
          setPersonas(data.personas || []);
        }
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleAssign = useCallback(
    async (personaId: string) => {
      if (!selectedTaskId) return;
      setAssigning(personaId);
      try {
        const targetId = personaId === assignedPersonaId ? null : personaId;
        await onAssign(selectedTaskId, targetId);
      } finally {
        setAssigning(null);
      }
    },
    [selectedTaskId, assignedPersonaId, onAssign],
  );

  if (loading) {
    return (
      <div className="worker-persona-sidebar">
        <div className="worker-persona-sidebar__header">
          <h3>👥 Personas</h3>
        </div>
        <p className="worker-persona-sidebar__loading">Laden…</p>
      </div>
    );
  }

  return (
    <div className="worker-persona-sidebar">
      <div className="worker-persona-sidebar__header">
        <h3>👥 Personas</h3>
        {selectedTaskId ? (
          <span className="worker-persona-sidebar__hint">Klick zum Zuweisen</span>
        ) : (
          <span className="worker-persona-sidebar__hint">Task auswählen</span>
        )}
      </div>

      {personas.length === 0 ? (
        <p className="worker-persona-sidebar__empty">Keine Personas vorhanden.</p>
      ) : (
        <div className="worker-persona-sidebar__list">
          {personas.map((persona) => {
            const isAssigned = persona.id === assignedPersonaId;
            const isLoading = assigning === persona.id;

            return (
              <button
                key={persona.id}
                className={`worker-persona-card ${isAssigned ? 'worker-persona-card--assigned' : ''}`}
                onClick={() => handleAssign(persona.id)}
                disabled={!selectedTaskId || isLoading}
                title={isAssigned ? 'Zuweisung aufheben' : `${persona.name} zuweisen`}
              >
                <span className="worker-persona-card__emoji">{persona.emoji}</span>
                <div className="worker-persona-card__info">
                  <span className="worker-persona-card__name">{persona.name}</span>
                  <span className="worker-persona-card__vibe">{persona.vibe}</span>
                </div>
                {isAssigned && <span className="worker-persona-card__badge">✓</span>}
                {isLoading && <span className="worker-persona-card__spinner">⏳</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default WorkerPersonaSidebar;
