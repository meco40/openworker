// ─── Worker Task List ───────────────────────────────────────
// Displays all worker tasks with status badges and workspace type.

import React from 'react';
import type { WorkerTask } from '../../types';

interface WorkerTaskListProps {
  tasks: WorkerTask[];
  loading: boolean;
  error: string | null;
  onSelectTask: (task: WorkerTask) => void;
  onCreateNew: () => void;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  queued: { label: 'In Warteschlange', color: '#6b7280', icon: '⏳' },
  planning: { label: 'Planung', color: '#3b82f6', icon: '🧠' },
  clarifying: { label: 'Rückfragen', color: '#8b5cf6', icon: '❓' },
  executing: { label: 'In Arbeit', color: '#f59e0b', icon: '⚙️' },
  waiting_approval: { label: 'Genehmigung', color: '#ec4899', icon: '🔒' },
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
}) => {
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
        <button className="worker-btn worker-btn--primary" onClick={onCreateNew}>
          + Neuer Workspace
        </button>
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
              <button
                key={task.id}
                className={`worker-task-card worker-task-card--${task.status}`}
                onClick={() => onSelectTask(task)}
              >
                <div className="worker-task-card__header">
                  <span className="worker-task-card__type" title={task.workspaceType}>
                    {typeIcon}
                  </span>
                  <span
                    className="worker-task-card__status"
                    style={{ backgroundColor: `${config.color}22`, color: config.color }}
                  >
                    {config.icon} {config.label}
                  </span>
                </div>

                <h3 className="worker-task-card__title">{task.title}</h3>
                <p className="worker-task-card__objective">
                  {task.objective.length > 100
                    ? task.objective.slice(0, 100) + '…'
                    : task.objective}
                </p>

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
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default WorkerTaskList;
