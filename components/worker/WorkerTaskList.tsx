// ─── Worker Task List ───────────────────────────────────────
// Displays all worker tasks with status badges and workspace type.

import React, { useState, useCallback } from 'react';
import type { WorkerTask } from '../../types';

interface WorkerTaskListProps {
  tasks: WorkerTask[];
  loading: boolean;
  error: string | null;
  onSelectTask: (task: WorkerTask) => void;
  onCreateNew: () => void;
  onDeleteTask: (id: string) => Promise<void>;
  onDeleteAllTasks: () => Promise<void>;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  inbox: { label: 'Eingang', color: '#8b5cf6', icon: '📥' },
  queued: { label: 'In Warteschlange', color: '#6b7280', icon: '⏳' },
  assigned: { label: 'Zugewiesen', color: '#0ea5e9', icon: '👤' },
  planning: { label: 'Planung', color: '#3b82f6', icon: '🧠' },
  clarifying: { label: 'Rückfragen', color: '#8b5cf6', icon: '❓' },
  executing: { label: 'In Arbeit', color: '#f59e0b', icon: '⚙️' },
  waiting_approval: { label: 'Genehmigung', color: '#ec4899', icon: '🔒' },
  testing: { label: 'Testing', color: '#14b8a6', icon: '🧪' },
  review: { label: 'Review', color: '#06b6d4', icon: '👀' },
  completed: { label: 'Abgeschlossen', color: '#10b981', icon: '✅' },
  failed: { label: 'Fehlgeschlagen', color: '#ef4444', icon: '❌' },
  cancelled: { label: 'Abgebrochen', color: '#6b7280', icon: '🚫' },
  interrupted: { label: 'Unterbrochen', color: '#f97316', icon: '⚡' },
};

const TYPE_ICONS: Record<string, string> = {
  research: '📚',
  webapp: '🌐',
  creative: '🎨',
  data: '📊',
  general: '📝',
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return 'Gerade eben';
  if (diff < 3600000) return `vor ${Math.floor(diff / 60000)} Min`;
  if (diff < 86400000) return `vor ${Math.floor(diff / 3600000)} Std`;
  return d.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const WorkerTaskList: React.FC<WorkerTaskListProps> = ({
  tasks,
  loading,
  error,
  onSelectTask,
  onCreateNew,
  onDeleteTask,
  onDeleteAllTasks,
}) => {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);

  const handleDeleteSingle = useCallback(async (id: string) => {
    setDeleting(id);
    try {
      await onDeleteTask(id);
    } finally {
      setDeleting(null);
      setConfirmDelete(null);
    }
  }, [onDeleteTask]);

  const handleDeleteAll = useCallback(async () => {
    setDeletingAll(true);
    try {
      await onDeleteAllTasks();
    } finally {
      setDeletingAll(false);
      setConfirmDeleteAll(false);
    }
  }, [onDeleteAllTasks]);
  if (loading && tasks.length === 0) {
    return (
      <div className="worker-task-list worker-task-list--loading">
        <div className="worker-loading-spinner" />
        <p>Workspaces laden…</p>
      </div>
    );
  }

  return (
    <div className="worker-task-list">
      <div className="worker-task-list__header">
        <h2>Workspaces</h2>
        <div className="worker-task-list__actions">
          {tasks.length > 0 && (
            <button
              className="worker-btn worker-btn--danger"
              onClick={() => setConfirmDeleteAll(true)}
              title="Alle Workspaces löschen"
            >
              🗑️ Alle löschen
            </button>
          )}
          <button className="worker-btn worker-btn--primary" onClick={onCreateNew}>
            + Neuer Workspace
          </button>
        </div>
      </div>

      {error && (
        <div className="worker-alert worker-alert--error">
          <span>⚠️</span> {error}
        </div>
      )}

      {tasks.length === 0 && !loading ? (
        <div className="worker-empty-state">
          <div className="worker-empty-state__icon">🚀</div>
          <h3>Keine Workspaces vorhanden</h3>
          <p>Erstelle einen neuen Workspace, um loszulegen.</p>
          <button className="worker-btn worker-btn--primary" onClick={onCreateNew}>
            + Neuer Workspace
          </button>
        </div>
      ) : (
        <div className="worker-task-grid">
          {tasks.map((task) => {
            const config = STATUS_CONFIG[task.status] || STATUS_CONFIG.queued;
            const typeIcon = TYPE_ICONS[task.workspaceType] || TYPE_ICONS.general;

            return (
              <div
                key={task.id}
                className={`worker-task-card worker-task-card--${task.status}`}
              >
                <div className="worker-task-card__header">
                  <span className="worker-task-card__type" title={task.workspaceType}>
                    {typeIcon}
                  </span>
                  <div className="worker-task-card__header-right">
                    <span
                      className="worker-task-card__status"
                      style={{ backgroundColor: `${config.color}22`, color: config.color }}
                    >
                      {config.icon} {config.label}
                    </span>
                    <button
                      className="worker-task-card__delete-btn"
                      title="Workspace löschen"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(task.id);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <button
                  className="worker-task-card__body"
                  onClick={() => onSelectTask(task)}
                >
                  <h3 className="worker-task-card__title">{task.title}</h3>
                  <p className="worker-task-card__objective">
                    {task.objective.length > 100
                      ? task.objective.slice(0, 100) + '…'
                      : task.objective}
                  </p>
                </button>

                <div className="worker-task-card__footer">
                  <span className="worker-task-card__date">{formatDate(task.createdAt)}</span>
                  {task.totalSteps > 0 && (
                    <span className="worker-task-card__progress">
                      {task.currentStep}/{task.totalSteps} Schritte
                    </span>
                  )}
                  {task.priority !== 'normal' && (
                    <span
                      className={`worker-task-card__priority worker-task-card__priority--${task.priority}`}
                    >
                      {task.priority === 'urgent' ? '🔴' : task.priority === 'high' ? '🟠' : '🔵'}{' '}
                      {task.priority}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ─── Delete Single Confirmation Modal ───────────────── */}
      {confirmDelete && (
        <div className="worker-modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="worker-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Workspace löschen?</h3>
            <p>Der Workspace und alle zugehörigen Dateien, Schritte und Artefakte werden unwiderruflich gelöscht.</p>
            <div className="worker-modal__actions">
              <button
                className="worker-btn worker-btn--ghost"
                onClick={() => setConfirmDelete(null)}
                disabled={!!deleting}
              >
                Abbrechen
              </button>
              <button
                className="worker-btn worker-btn--danger"
                onClick={() => handleDeleteSingle(confirmDelete)}
                disabled={!!deleting}
              >
                {deleting ? 'Löschen…' : '🗑️ Endgültig löschen'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Delete All Confirmation Modal ────────────────────── */}
      {confirmDeleteAll && (
        <div className="worker-modal-overlay" onClick={() => setConfirmDeleteAll(false)}>
          <div className="worker-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Alle Workspaces löschen?</h3>
            <p>
              <strong>{tasks.length}</strong> Workspaces und alle zugehörigen Dateien werden unwiderruflich gelöscht. Dieser Vorgang kann nicht rückgängig gemacht werden.
            </p>
            <div className="worker-modal__actions">
              <button
                className="worker-btn worker-btn--ghost"
                onClick={() => setConfirmDeleteAll(false)}
                disabled={deletingAll}
              >
                Abbrechen
              </button>
              <button
                className="worker-btn worker-btn--danger"
                onClick={handleDeleteAll}
                disabled={deletingAll}
              >
                {deletingAll ? 'Löschen…' : `🗑️ Alle ${tasks.length} löschen`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkerTaskList;
